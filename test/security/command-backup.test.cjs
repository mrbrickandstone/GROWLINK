"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Store } = require("../../security/server/store.cjs");
const { signingKey } = require("../../security/server/evidence.cjs");
const {
  snapshot,
  verifySnapshot,
  readConfig,
  createBackup,
} = require("../../security/server/backup.cjs");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-backup-test-"));
  const source = path.join(root, "source"),
    store = new Store(source);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.put("holds", "hold-1", {
    id: "hold-1",
    releasedAt: null,
    reason: "synthetic investigation",
  });
  store.put("users", "owner", { id: "owner", enabled: true });
  store.put("grants", "request-1", { id: "request-1", userId: "inspector" });
  store.put("deletions", "old-request", { state: "approved" });
  store.enqueue({ kind: "fixture", cameraId: "one" });
  store.session("synthetic-session", { userId: "owner" }, Date.now() + 100000);
  const key = signingKey(source),
    manifestText = '{"test":"synthetic evidence only"}\n';
  store.put("exports", "export-1", {
    state: "complete",
    manifestText,
    signature: crypto
      .sign(null, Buffer.from(manifestText), key)
      .toString("base64"),
    publicKey: crypto
      .createPublicKey(key)
      .export({ type: "spki", format: "pem" }),
  });
  store.audit({ id: "test" }, "test.initialized", {});
  return { root, source, store };
}
test("online SQLite backup captures consistent WAL state, holds, jobs and matching signing key during writes", async (t) => {
  const { root, source, store } = setup(t);
  store.db.exec("PRAGMA wal_autocheckpoint=0");
  for (let i = 0; i < 100; i++)
    store.put("fixture", String(i), { content: "a".repeat(8192) });
  assert.ok(fs.statSync(path.join(source, "command.sqlite-wal")).size > 0);
  let wrote = false;
  const result = await snapshot(source, path.join(root, "copy"), {
    rate: 1,
    progress() {
      if (!wrote) {
        wrote = true;
        store.tx(() => {
          store.put("holds", "hold-2", { id: "hold-2" });
          store.audit({ id: "writer" }, "hold.test", {});
        });
      }
    },
  });
  assert.ok(wrote);
  assert.equal(result.manifest.database.audit.valid, true);
  assert.equal(
    result.manifest.database.recordCounts.holds,
    result.manifest.database.audit.count,
  );
  assert.equal(result.manifest.database.signedExports, 1);
  assert.equal(result.manifest.database.jobs, 1);
  assert.equal(result.manifest.database.sessions, 1);
  assert.equal(result.manifest.originalFootageIncluded, false);
  assert.equal(
    await verifySnapshot(path.join(root, "copy"), result.manifestSha256).then(
      (x) => x.schema,
    ),
    "farber-control-backup-v1",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "copy/evidence-signing.pem"), "utf8"),
    fs.readFileSync(path.join(source, "evidence-signing.pem"), "utf8"),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "copy")).sort(), [
    "RECOVERY_REQUIRED",
    "backup-manifest.json",
    "command.sqlite",
    "evidence-signing.pem",
  ]);
  assert.ok(store.auditIntegrity().valid);
});
test("backup rejects missing or wrong signing keys, invalid signatures and broken audit history", async (t) => {
  const { root, source, store } = setup(t),
    file = path.join(source, "evidence-signing.pem");
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  await assert.rejects(
    snapshot(source, path.join(root, "missing")),
    /BACKUP_SIGNING_KEY_MISSING/,
  );
  assert.equal(fs.existsSync(path.join(root, "missing")), false);
  signingKey(source);
  await assert.rejects(
    snapshot(source, path.join(root, "wrong")),
    /BACKUP_EXPORT_SIGNATURE_INVALID/,
  );
  fs.writeFileSync(file, original);
  const record = store.get("exports", "export-1");
  store.put("exports", "export-1", { ...record, manifestText: "changed" });
  await assert.rejects(
    snapshot(source, path.join(root, "signature")),
    /BACKUP_EXPORT_SIGNATURE_INVALID/,
  );
  store.put("exports", "export-1", record);
  store.db.prepare("UPDATE audit SET event='changed' WHERE seq=1").run();
  await assert.rejects(
    snapshot(source, path.join(root, "audit")),
    /BACKUP_AUDIT_INVALID/,
  );
});
test("a fresh installation can be backed up before its first signing key exists", async (t) => {
  const { root, source, store } = setup(t);
  store.db.prepare("DELETE FROM records WHERE kind='exports'").run();
  fs.unlinkSync(path.join(source, "evidence-signing.pem"));
  const result = await snapshot(source, path.join(root, "fresh"));
  assert.equal(result.manifest.database.signingKeyFingerprint, null);
  assert.equal(result.manifest.database.signedExports, 0);
  assert.equal(result.manifest.files.length, 2);
});
test("restore verification requires trusted manifest hash and rejects altered, extra or symlinked files", async (t) => {
  const { root, source } = setup(t),
    copy = path.join(root, "copy");
  const result = await snapshot(source, copy);
  await assert.rejects(
    verifySnapshot(copy, "0".repeat(64)),
    /BACKUP_CHECKPOINT_MISMATCH/,
  );
  await assert.rejects(
    verifySnapshot(copy),
    /TRUSTED_BACKUP_CHECKPOINT_REQUIRED/,
  );
  fs.writeFileSync(path.join(copy, "unexpected"), "extra");
  await assert.rejects(
    verifySnapshot(copy, result.manifestSha256),
    /BACKUP_FILE_INVENTORY_INVALID/,
  );
  fs.unlinkSync(path.join(copy, "unexpected"));
  const keyFile = path.join(copy, "evidence-signing.pem"),
    original = fs.readFileSync(keyFile);
  fs.appendFileSync(keyFile, "tamper");
  await assert.rejects(
    verifySnapshot(copy, result.manifestSha256),
    /BACKUP_FILE_HASH_MISMATCH/,
  );
  fs.unlinkSync(keyFile);
  fs.symlinkSync(path.join(source, "evidence-signing.pem"), keyFile);
  await assert.rejects(verifySnapshot(copy, result.manifestSha256));
  fs.unlinkSync(keyFile);
  fs.writeFileSync(keyFile, original, { mode: 0o600 });
  await verifySnapshot(copy, result.manifestSha256);
  await assert.rejects(snapshot(source, copy), /EEXIST/);
});
test("recovered databases cannot start a worker or CLI and retain untouched historical state", async (t) => {
  const { root, source } = setup(t),
    copy = path.join(root, "copy");
  const result = await snapshot(source, copy);
  assert.throws(() => new Store(copy), /RECOVERY_REVALIDATION_REQUIRED/);
  for (const [entry, args] of [
    ["worker.cjs", ["--once"]],
    ["cli.cjs", ["init-site"]],
  ]) {
    const run = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../security", entry), ...args],
      {
        env: { PATH: process.env.PATH, SECURITY_DATA_DIR: copy },
        encoding: "utf8",
      },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /RECOVERY_REVALIDATION_REQUIRED/);
  }
  await verifySnapshot(copy, result.manifestSha256);
});
test("backup config rejects exposed secrets, unsafe executable/environment and repository URLs", (t) => {
  const { root, source } = setup(t),
    file = path.join(root, "config.json"),
    password = path.join(root, "password");
  fs.writeFileSync(password, "synthetic-test-secret", { mode: 0o600 });
  const good = {
    dataDir: source,
    stagingParent: root,
    resticBinary: process.execPath,
    passwordFile: password,
    repository: path.join(root, "repo"),
  };
  const write = (value) =>
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  write(good);
  assert.equal(readConfig(file).dataDir, source);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readConfig(file), /PRIVATE_BACKUP_CONFIG_INVALID/);
  fs.chmodSync(file, 0o600);
  for (const change of [
    { credentials: { NODE_OPTIONS: "sentinel" } },
    { repository: "s3:https://user:sentinel@example.com/bucket" },
    { repository: "s3:http://example.com/bucket" },
    { passwordFile: "/does/not/exist" },
    { resticBinary: "restic" },
  ]) {
    write({ ...good, ...change });
    assert.throws(() => readConfig(file), /PRIVATE_BACKUP_CONFIG_INVALID/);
  }
  write(good);
  fs.symlinkSync(file, path.join(root, "link"));
  assert.throws(
    () => readConfig(path.join(root, "link")),
    /PRIVATE_BACKUP_CONFIG_INVALID/,
  );
});
test("partial restic exit fails without checkpoint or plaintext leftovers and never prints child secrets", async (t) => {
  const { root, source } = setup(t),
    executable = path.join(root, "restic-fixture"),
    password = path.join(root, "password");
  fs.writeFileSync(
    executable,
    '#!/bin/sh\necho "SENSITIVE_TEST_SENTINEL" >&2\nexit 3\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(password, "synthetic-only", { mode: 0o600 });
  const config = {
    dataDir: source,
    stagingParent: root,
    resticBinary: executable,
    passwordFile: password,
    repository: path.join(root, "repo"),
  };
  const checkpoint = path.join(root, "checkpoint.json");
  await assert.rejects(
    createBackup(config, checkpoint),
    /^Error: RESTIC_OPERATION_FAILED$/,
  );
  assert.equal(fs.existsSync(checkpoint), false);
  assert.ok(
    !fs.readdirSync(root).some((name) => name.startsWith("farber-backup-")),
  );
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const run = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../security/backup.cjs"),
      "backup",
      file,
      checkpoint,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /RESTIC_OPERATION_FAILED/);
  assert.doesNotMatch(run.stderr, /SENSITIVE_TEST_SENTINEL/);
});
