"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { digest, auditIntegrity } = require("./audit.cjs");
const { QUEUE_INDEXES } = require("./queue-priority.cjs");
const { hashFile } = require("../../lib/security/ring-pilot.cjs");
const execute = promisify(execFile);
const DB = "command.sqlite",
  KEY = "evidence-signing.pem",
  MANIFEST = "backup-manifest.json";
const MARKER = "RECOVERY_REQUIRED";
const MARKER_TEXT =
  "Farber recovery quarantine: revalidate identities, holds, deletion requests, policy and archived originals before activation.\n";
const HEX = /^[a-f0-9]{64}$/;
function fail(code) {
  throw new Error(code);
}
function privateFile(file, limit = Infinity) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size > limit ||
      ![0, process.getuid()].includes(stat.uid)
    )
      fail("PRIVATE_BACKUP_FILE_REQUIRED");
    return stat;
  } finally {
    fs.closeSync(fd);
  }
}
function privateDirectory(dir) {
  if (!path.isAbsolute(dir)) fail("ABSOLUTE_BACKUP_PATH_REQUIRED");
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    ![0, process.getuid()].includes(stat.uid)
  )
    fail("PRIVATE_BACKUP_DIRECTORY_REQUIRED");
  return fs.realpathSync(dir);
}
function newDirectory(dir) {
  if (!path.isAbsolute(dir)) fail("ABSOLUTE_BACKUP_PATH_REQUIRED");
  const resolved = path.join(
    fs.realpathSync(path.dirname(dir)),
    path.basename(dir),
  );
  fs.mkdirSync(resolved, { mode: 0o700 }); // Deliberately refuses existing targets.
  return resolved;
}
function writePrivate(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function inspectDatabase(root) {
  privateFile(path.join(root, DB));
  const db = new DatabaseSync(path.join(root, DB), { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
    const schema = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    if (
      JSON.stringify(
        schema.filter((r) => r.type === "table").map((r) => [r.type, r.name]),
      ) !==
      JSON.stringify(
        ["audit", "jobs", "records", "sessions"].map((name) => ["table", name]),
      )
    )
      fail("BACKUP_SCHEMA_UNSUPPORTED");
    // Old snapshots may have no queue indexes. New snapshots permit only these
    // exact indexes; extra indexes, triggers and views remain rejected.
    for (const r of schema.filter((r) => r.type !== "table")) {
      if (
        r.type !== "index" ||
        !QUEUE_INDEXES[r.name] ||
        r.sql !== QUEUE_INDEXES[r.name]
      )
        fail("BACKUP_SCHEMA_UNSUPPORTED");
    }
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      fail("BACKUP_DATABASE_CORRUPT");
    const audit = auditIntegrity(db);
    if (!audit.valid) fail("BACKUP_AUDIT_INVALID");
    let key = null,
      fingerprint = null;
    try {
      privateFile(path.join(root, KEY), 16384);
      key = crypto.createPrivateKey(fs.readFileSync(path.join(root, KEY)));
      if (key.asymmetricKeyType !== "ed25519")
        fail("BACKUP_SIGNING_KEY_INVALID");
      fingerprint = digest(
        crypto.createPublicKey(key).export({ type: "spki", format: "der" }),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    let signedExports = 0;
    for (const row of db
      .prepare("SELECT data FROM records WHERE kind='exports'")
      .iterate()) {
      const record = JSON.parse(row.data);
      if (record.state !== "complete") continue;
      if (!key) fail("BACKUP_SIGNING_KEY_MISSING");
      const exportedKey = crypto.createPublicKey(record.publicKey);
      if (
        digest(exportedKey.export({ type: "spki", format: "der" })) !==
          fingerprint ||
        typeof record.manifestText !== "string" ||
        !crypto.verify(
          null,
          Buffer.from(record.manifestText),
          exportedKey,
          Buffer.from(record.signature, "base64"),
        )
      )
        fail("BACKUP_EXPORT_SIGNATURE_INVALID");
      signedExports++;
    }
    return {
      audit,
      recordCounts: Object.fromEntries(
        db
          .prepare(
            "SELECT kind,count(*) AS n FROM records GROUP BY kind ORDER BY kind",
          )
          .all()
          .map((r) => [r.kind, r.n]),
      ),
      jobs: db.prepare("SELECT count(*) AS n FROM jobs").get().n,
      sessions: db.prepare("SELECT count(*) AS n FROM sessions").get().n,
      signedExports,
      signingKeyFingerprint: fingerprint,
    };
  } finally {
    db.close();
  }
}
async function snapshot(sourceRoot, destination, options = {}) {
  sourceRoot = privateDirectory(sourceRoot);
  privateFile(path.join(sourceRoot, DB));
  if (fs.existsSync(path.join(sourceRoot, MARKER)))
    fail("RECOVERY_REVALIDATION_REQUIRED");
  const root = newDirectory(destination);
  let source;
  try {
    writePrivate(path.join(root, MARKER), MARKER_TEXT);
    source = new DatabaseSync(path.join(sourceRoot, DB), { readOnly: true });
    await backup(source, path.join(root, DB), {
      rate: options.rate || 100,
      progress: options.progress,
    });
    source.close();
    source = null;
    fs.chmodSync(path.join(root, DB), 0o600);
    const copy = new DatabaseSync(path.join(root, DB));
    try {
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    } finally {
      copy.close();
    }
    const files = [DB, MARKER];
    try {
      privateFile(path.join(sourceRoot, KEY), 16384);
      writePrivate(
        path.join(root, KEY),
        fs.readFileSync(path.join(sourceRoot, KEY)),
      );
      files.push(KEY);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const database = inspectDatabase(root);
    const manifest = {
      schema: "farber-control-backup-v1",
      createdAt: new Date().toISOString(),
      originalFootageIncluded: false,
      recoveryRevalidationRequired: true,
      database,
      files: await Promise.all(
        files.sort().map(async (name) => ({
          name,
          bytes: privateFile(path.join(root, name)).size,
          sha256: await hashFile(path.join(root, name)),
        })),
      ),
    };
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    writePrivate(path.join(root, MANIFEST), bytes);
    const manifestSha256 = digest(bytes);
    await verifySnapshot(root, manifestSha256);
    return { manifestSha256, manifest };
  } catch (e) {
    source?.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
async function verifySnapshot(root, expectedManifestSha256) {
  root = privateDirectory(root);
  if (!HEX.test(expectedManifestSha256 || ""))
    fail("TRUSTED_BACKUP_CHECKPOINT_REQUIRED");
  privateFile(path.join(root, MANIFEST), 1048576);
  const bytes = fs.readFileSync(path.join(root, MANIFEST));
  if (digest(bytes) !== expectedManifestSha256)
    fail("BACKUP_CHECKPOINT_MISMATCH");
  const manifest = JSON.parse(bytes);
  if (
    manifest.schema !== "farber-control-backup-v1" ||
    manifest.originalFootageIncluded !== false ||
    manifest.recoveryRevalidationRequired !== true ||
    !Array.isArray(manifest.files)
  )
    fail("BACKUP_MANIFEST_INVALID");
  const names = manifest.files.map((f) => f.name).sort();
  const expected = [DB, MARKER, ...(names.includes(KEY) ? [KEY] : [])].sort();
  if (
    JSON.stringify(names) !== JSON.stringify(expected) ||
    JSON.stringify(fs.readdirSync(root).sort()) !==
      JSON.stringify([...expected, MANIFEST].sort())
  )
    fail("BACKUP_FILE_INVENTORY_INVALID");
  for (const file of manifest.files) {
    const target = path.join(root, file.name);
    if (
      privateFile(target).size !== file.bytes ||
      !HEX.test(file.sha256 || "") ||
      (await hashFile(target)) !== file.sha256
    )
      fail("BACKUP_FILE_HASH_MISMATCH");
  }
  if (fs.readFileSync(path.join(root, MARKER), "utf8") !== MARKER_TEXT)
    fail("BACKUP_QUARANTINE_MISSING");
  if (
    JSON.stringify(inspectDatabase(root)) !== JSON.stringify(manifest.database)
  )
    fail("BACKUP_METADATA_MISMATCH");
  return manifest;
}
const CREDENTIAL_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_DEFAULT_REGION",
];
function readConfig(file) {
  try {
    privateFile(file, 32768);
    const c = JSON.parse(fs.readFileSync(file));
    const fields = [
      "dataDir",
      "stagingParent",
      "resticBinary",
      "repository",
      "passwordFile",
      "credentials",
    ];
    if (!c || Object.keys(c).some((k) => !fields.includes(k))) fail("INVALID");
    for (const k of fields.filter((k) => k !== "credentials"))
      if (typeof c[k] !== "string" || !c[k]) fail("INVALID");
    if (
      !path.isAbsolute(c.dataDir) ||
      !path.isAbsolute(c.resticBinary) ||
      !path.isAbsolute(c.passwordFile)
    )
      fail("INVALID");
    privateDirectory(c.stagingParent);
    privateFile(c.passwordFile, 4096);
    if (!fs.readFileSync(c.passwordFile, "utf8").trim()) fail("INVALID");
    const executable = fs.statSync(c.resticBinary);
    if (
      !executable.isFile() ||
      executable.mode & 0o022 ||
      ![0, process.getuid()].includes(executable.uid)
    )
      fail("INVALID");
    fs.accessSync(c.resticBinary, fs.constants.X_OK);
    if (!path.isAbsolute(c.repository)) {
      if (!c.repository.startsWith("s3:https://")) fail("INVALID");
      const u = new URL(c.repository.slice(3));
      if (u.username || u.password || u.search || u.hash || u.pathname === "/")
        fail("INVALID");
    }
    if (
      c.credentials &&
      (typeof c.credentials !== "object" ||
        Array.isArray(c.credentials) ||
        Object.entries(c.credentials).some(
          ([k, v]) =>
            !CREDENTIAL_KEYS.includes(k) ||
            typeof v !== "string" ||
            !v ||
            v.includes("\0"),
        ))
    )
      fail("INVALID");
    return c;
  } catch {
    fail("PRIVATE_BACKUP_CONFIG_INVALID");
  }
}
async function restic(config, args, cwd) {
  try {
    const result = await execute(
      config.resticBinary,
      ["--no-cache", "--json", ...args],
      {
        cwd,
        env: {
          PATH: "/usr/bin:/bin",
          RESTIC_REPOSITORY: config.repository,
          RESTIC_PASSWORD_FILE: config.passwordFile,
          AWS_EC2_METADATA_DISABLED: "true",
          ...(config.credentials || {}),
        },
        timeout: 600000,
        killSignal: "SIGKILL",
        maxBuffer: 8388608,
      },
    );
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    fail("RESTIC_OPERATION_FAILED");
  } // Never relay provider URLs, credentials or tool output.
}
function readCheckpoint(file) {
  try {
    privateFile(file, 32768);
    const c = JSON.parse(fs.readFileSync(file));
    if (
      c.schema !== "farber-backup-checkpoint-v1" ||
      !HEX.test(c.snapshotId || "") ||
      !HEX.test(c.manifestSha256 || "") ||
      c.restoreVerified !== true
    )
      fail("INVALID");
    return c;
  } catch {
    fail("TRUSTED_BACKUP_CHECKPOINT_REQUIRED");
  }
}
async function restore(config, checkpoint, destination) {
  if (
    !HEX.test(checkpoint.snapshotId || "") ||
    !HEX.test(checkpoint.manifestSha256 || "")
  )
    fail("TRUSTED_BACKUP_CHECKPOINT_REQUIRED");
  const root = newDirectory(destination);
  try {
    writePrivate(path.join(root, MARKER), MARKER_TEXT);
    await restic(
      config,
      [
        "restore",
        checkpoint.snapshotId,
        "--target",
        root,
        "--overwrite",
        "never",
        "--verify",
        ...[DB, KEY, MANIFEST, MARKER].flatMap((name) => [
          "--include",
          "/" + name,
        ]),
      ],
      root,
    );
    return await verifySnapshot(root, checkpoint.manifestSha256);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
async function createBackup(config, checkpointFile) {
  if (!path.isAbsolute(checkpointFile)) fail("ABSOLUTE_BACKUP_PATH_REQUIRED");
  // Reserve before upload; an existing checkpoint is never overwritten.
  const fd = fs.openSync(checkpointFile, "wx", 0o600);
  let work;
  try {
    work = fs.mkdtempSync(
      path.join(privateDirectory(config.stagingParent), "farber-backup-"),
    );
    const payload = path.join(work, "payload");
    const { manifest, manifestSha256 } = await snapshot(
      config.dataDir,
      payload,
    );
    const result = await restic(
      config,
      [
        "backup",
        "--host",
        "farber-security",
        "--tag",
        "farber-control-v1",
        "--",
        ...fs.readdirSync(payload).sort(),
      ],
      payload,
    );
    const summary = result.find((r) => r.message_type === "summary");
    if (!HEX.test(summary?.snapshot_id || ""))
      fail("BACKUP_SNAPSHOT_ID_MISSING");
    const checkpoint = {
      schema: "farber-backup-checkpoint-v1",
      snapshotId: summary.snapshot_id,
      manifestSha256,
      createdAt: manifest.createdAt,
      audit: manifest.database.audit,
      originalFootageIncluded: false,
      independentLocationVerified: false,
      restoreVerified: true,
    };
    await restore(config, checkpoint, path.join(work, "readback"));
    fs.writeFileSync(fd, JSON.stringify(checkpoint, null, 2) + "\n");
    fs.fsyncSync(fd);
    return checkpoint;
  } catch (e) {
    fs.rmSync(checkpointFile, { force: true });
    throw e;
  } finally {
    fs.closeSync(fd);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}
module.exports = {
  snapshot,
  inspectDatabase,
  verifySnapshot,
  readConfig,
  readCheckpoint,
  createBackup,
  restore,
};
