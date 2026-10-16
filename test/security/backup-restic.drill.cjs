"use strict";
// Explicit integration drill. Requires a separately verified restic binary; never uses account credentials.
process.umask(0o077);
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("../../security/server/store.cjs");
const { signingKey } = require("../../security/server/evidence.cjs");
const {
  readConfig,
  readCheckpoint,
  createBackup,
  restore,
  verifySnapshot,
} = require("../../security/server/backup.cjs");
test("real restic encrypted repository survives synthetic host loss and rejects wrong password and corrupt packs", async (t) => {
  const binary = process.env.FARBER_TEST_RESTIC;
  assert.ok(
    binary && path.isAbsolute(binary),
    "Supply the absolute path of a verified restic binary in FARBER_TEST_RESTIC",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-restic-drill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    repository = path.join(root, "encrypted-repo"),
    passwordFile = path.join(root, "password");
  fs.writeFileSync(passwordFile, crypto.randomBytes(48).toString("base64"), {
    mode: 0o600,
  });
  const env = {
    PATH: "/usr/bin:/bin",
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD_FILE: passwordFile,
  };
  const run = (args) =>
    execFileSync(binary, ["--no-cache", "--json", ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run(["init"]);
  const store = new Store(source),
    sentinel =
      "FARBER_SYNTHETIC_PRIVATE_" + crypto.randomBytes(24).toString("hex");
  const key = signingKey(source),
    originalKey = fs.readFileSync(path.join(source, "evidence-signing.pem"));
  const manifestText = JSON.stringify({
    requestId: "synthetic-only",
    evidence: sentinel,
  });
  const record = {
    state: "complete",
    manifestText,
    signature: crypto
      .sign(null, Buffer.from(manifestText), key)
      .toString("base64"),
    publicKey: crypto
      .createPublicKey(key)
      .export({ type: "spki", format: "pem" }),
  };
  store.put("exports", "synthetic-export", record);
  store.put("holds", "synthetic-hold", {
    id: "synthetic-hold",
    reason: sentinel,
    releasedAt: null,
  });
  store.registerUser({
    id: "synthetic-owner",
    name: "Test owner",
    role: "owner",
    cameraIds: ["*"],
  });
  store.enqueue({ kind: "fixture", cameraId: "one" });
  const configFile = path.join(root, "config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      dataDir: source,
      stagingParent: root,
      resticBinary: binary,
      repository,
      passwordFile,
    }),
    { mode: 0o600 },
  );
  const config = readConfig(configFile),
    stateDir = path.join(root, "schedule-state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const schedule = {
    backup: config,
    stateDir,
    intervalMinutes: 60,
    minimumFreeBytes: 1000000000,
    maxRunMinutes: 15,
  };
  let checkpoint, checkpointFile;
  try {
    const scheduler = require("../../security/server/backup-scheduler.cjs");
    assert.equal((await scheduler.run(schedule)).state, "complete");
    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "status.json")),
    );
    checkpointFile = path.join(
      stateDir,
      "checkpoints",
      state.lastSuccess.checkpoint,
    );
    checkpoint = readCheckpoint(checkpointFile);
    assert.equal((await scheduler.run(schedule)).state, "not-due");
    assert.equal(
      scheduler.observe({ SECURITY_BACKUP_STATE_DIR: stateDir }).state,
      "verified",
    );
  } finally {
    store.close();
  }
  assert.deepEqual(readCheckpoint(checkpointFile), checkpoint);
  assert.equal(checkpoint.restoreVerified, true);
  assert.equal(checkpoint.independentLocationVerified, false);
  assert.equal(checkpoint.originalFootageIncluded, false);
  assert.ok(
    !fs.readdirSync(root).some((name) => name.startsWith("farber-backup-")),
  );
  run(["check", "--read-data"]);
  function files(dir) {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? files(path.join(dir, entry.name))
          : [path.join(dir, entry.name)],
      );
  }
  for (const file of files(repository)) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(Buffer.from(sentinel)), false);
    assert.equal(
      bytes.includes(Buffer.from("-----BEGIN PRIVATE KEY-----")),
      false,
    );
  }
  fs.rmSync(source, { recursive: true }); // Only disposable synthetic source; simulates loss of database and key.
  const recovered = path.join(root, "recovered");
  const manifest = await restore(config, checkpoint, recovered);
  assert.equal(manifest.database.recordCounts.holds, 1);
  assert.equal(manifest.database.recordCounts.users, 1);
  assert.equal(manifest.database.jobs, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(recovered, "evidence-signing.pem")),
    originalKey,
  );
  const db = new DatabaseSync(path.join(recovered, "command.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      JSON.parse(
        db.prepare("SELECT data FROM records WHERE kind='holds'").get().data,
      ).reason,
      sentinel,
    );
    const restoredExport = JSON.parse(
      db.prepare("SELECT data FROM records WHERE kind='exports'").get().data,
    );
    assert.ok(
      crypto.verify(
        null,
        Buffer.from(restoredExport.manifestText),
        restoredExport.publicKey,
        Buffer.from(restoredExport.signature, "base64"),
      ),
    );
  } finally {
    db.close();
  }
  assert.throws(() => new Store(recovered), /RECOVERY_REVALIDATION_REQUIRED/);
  const candidate = path.join(root, "recovery-review");
  const prepared =
    await require("../../security/server/recovery.cjs").prepareRecovery(
      recovered,
      checkpoint,
      candidate,
      "SYNTHETIC-HOST-LOSS-REVIEW",
    );
  assert.equal(prepared.productionReady, false);
  const disarmed = new Store(candidate);
  try {
    assert.equal(disarmed.recoveryPending(), true);
    assert.equal(
      disarmed.db.prepare("SELECT count(*) AS n FROM sessions").get().n,
      0,
    );
    assert.equal(
      disarmed.all("users").every((u) => !u.enabled),
      true,
    );
    assert.equal(disarmed.auditIntegrity().valid, true);
    assert.equal(disarmed.all("exports")[0].state, "recovery-suspended");
  } finally {
    disarmed.close();
  }
  await assert.rejects(restore(config, checkpoint, recovered), /EEXIST/);
  const wrongPassword = path.join(root, "wrong-password");
  fs.writeFileSync(wrongPassword, crypto.randomBytes(48).toString("base64"), {
    mode: 0o600,
  });
  await assert.rejects(
    restore(
      { ...config, passwordFile: wrongPassword },
      checkpoint,
      path.join(root, "wrong"),
    ),
    /RESTIC_OPERATION_FAILED/,
  );
  assert.equal(fs.existsSync(path.join(root, "wrong")), false);
  const pack = files(path.join(repository, "data"))[0],
    packed = fs.readFileSync(pack);
  packed[Math.floor(packed.length / 2)] ^= 0xff;
  fs.chmodSync(pack, 0o600); // Restic protects packs as read-only; alter only this disposable fixture.
  fs.writeFileSync(pack, packed);
  await assert.rejects(
    restore(config, checkpoint, path.join(root, "corrupt")),
    /RESTIC_OPERATION_FAILED/,
  );
  assert.equal(fs.existsSync(path.join(root, "corrupt")), false);
  await verifySnapshot(recovered, checkpoint.manifestSha256);
});
