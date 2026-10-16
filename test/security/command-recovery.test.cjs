"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn, spawnSync } = require("node:child_process"),
  { once } = require("node:events");
const { Store, digest } = require("../../security/server/store.cjs"),
  {
    snapshot,
    verifySnapshot,
    inspectDatabase,
  } = require("../../security/server/backup.cjs"),
  { prepareRecovery } = require("../../security/server/recovery.cjs"),
  { signingKey } = require("../../security/server/evidence.cjs"),
  { LocalArchive } = require("../../security/server/archive.cjs"),
  {
    scheduleVerification,
    processVerification,
  } = require("../../security/server/reconciliation.cjs"),
  {
    scheduleRing,
    transfer,
    reconcileHolds,
  } = require("../../security/server/transfer.cjs"),
  { eligible } = require("../../security/server/cache.cjs"),
  { createServer } = require("../../security/server/http.cjs");
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-recovery-")),
    source = path.join(root, "source"),
    restored = path.join(root, "restored"),
    target = path.join(root, "candidate"),
    store = new Store(source),
    at = Date.now(),
    bytes = Buffer.from("synthetic recovery bytes"),
    hash = digest(bytes),
    owner = {
      id: "owner",
      name: "Fixture owner",
      role: "owner",
      cameraIds: ["*"],
      mfa: true,
      csrf: "fixture",
    };
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const u of [
    owner,
    {
      id: "inspector",
      name: "Inspector",
      role: "inspector",
      cameraIds: ["one"],
    },
  ])
    store.registerUser(u);
  store.put("cameras", "one", {
    id: "one",
    name: "One",
    source: "ring",
    room: "FLOWERING",
    exportEnabled: true,
    enabledAt: at - 3600000,
  });
  store.put("policy", "ring", {
    automatedExportsApproved: true,
    retentionApproved: true,
    inspectorApproved: true,
    decisionReference: "synthetic policy",
  });
  const job = store.enqueue({
    kind: "ring-export",
    cameraId: "one",
    requestStart: at - 1800000,
    requestEnd: at - 1500000,
  });
  store.claim();
  const segmentId = "a".repeat(64),
    segment = {
      id: segmentId,
      cameraId: "one",
      source: "ring",
      start: 100,
      end: 200,
      requested: { start: 100, end: 200 },
      sha256: hash,
      bytes: bytes.length,
      verified: true,
      ingestedAt: 1,
      receipt: {
        objectKey: `originals/${hash.slice(0, 2)}/${hash}.mp4`,
        versionId: hash,
        sha256: hash,
        size: bytes.length,
        independent: false,
        readbackVerifiedAt: at,
        immutableStorageVerified: true,
        retainUntil: 1,
      },
      derivative: { video: segmentId + ".mp4", sha256: hash },
      cache: { materializedAt: at },
    };
  store.put("segments", segmentId, segment);
  store.addHold(owner, {
    cameraId: "one",
    start: 100,
    end: 200,
    caseReference: "CASE",
    reason: "Synthetic investigation",
  });
  store.grant(owner, {
    userId: "inspector",
    cameraIds: ["one"],
    start: 100,
    end: 200,
    requestId: "REQUEST",
    purpose: "Fixture",
    expiresAt: at + 600000,
  });
  store.put("deletions", "old-delete", {
    id: "old-delete",
    state: "approved",
    segmentId,
    requestedBy: "owner",
    approvedBy: "second-owner",
  });
  store.put("heartbeats", "archive-worker", { at, status: "ok" });
  store.put("archive-checks", segmentId, {
    state: "verified",
    lastVerifiedAt: at,
  });
  store.session(
    "old-cookie",
    { kind: "user", userId: "owner", mfa: true, csrf: "old-csrf" },
    at + 3600000,
  );
  const key = signingKey(source),
    manifestText = '{"requestId":"SYNTHETIC-OLD-EXPORT"}\n';
  store.put("exports", "old-export", {
    id: "old-export",
    state: "complete",
    createdBy: "owner",
    segmentIds: [segmentId],
    manifestText,
    signature: crypto
      .sign(null, Buffer.from(manifestText), key)
      .toString("base64"),
    publicKey: crypto
      .createPublicKey(key)
      .export({ type: "spki", format: "pem" }),
  });
  const saved = await snapshot(source, restored),
    checkpoint = {
      schema: "farber-backup-checkpoint-v1",
      snapshotId: "b".repeat(64),
      manifestSha256: saved.manifestSha256,
      createdAt: saved.manifest.createdAt,
      audit: saved.manifest.database.audit,
      restoreVerified: true,
    };
  const checkpointFile = path.join(root, "checkpoint.json");
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
  return {
    root,
    source,
    restored,
    target,
    store,
    owner,
    job,
    segmentId,
    segment,
    bytes,
    checkpoint,
    checkpointFile,
  };
}
function openCandidate(t, f) {
  const s = new Store(f.target);
  t.after(() => s.close());
  return s;
}
test("recovery CLI reads the private checkpoint and reports preparation without publishing names, paths or old session secrets", async (t) => {
  const f = await fixture(t);
  const run = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../security/recovery.cjs"),
      "prepare",
      f.restored,
      f.checkpointFile,
      f.target,
      "CLI-RECOVERY-CASE",
    ],
    {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.prepared, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.counts.sessionsRevoked, 1);
  for (const privateValue of [
    f.root,
    "old-cookie",
    "old-csrf",
    "Fixture owner",
  ])
    assert.equal((run.stdout + run.stderr).includes(privateValue), false);
  const s = openCandidate(t, f);
  assert.equal(s.recoveryPending(), true);
});
test("recovery preparation preserves the trusted snapshot and signed history while disarming old authority and footage credit", async (t) => {
  const f = await fixture(t),
    report = await prepareRecovery(
      f.restored,
      f.checkpoint,
      f.target,
      "RECOVERY-CASE-1",
    );
  await verifySnapshot(f.restored, f.checkpoint.manifestSha256);
  assert.equal(report.productionReady, false);
  assert.equal(report.newestSnapshotVerified, false);
  const s = openCandidate(t, f);
  assert.equal(s.recoveryPending(), true);
  assert.equal(s.getSession("old-cookie"), null);
  assert.equal(s.user("owner"), null);
  assert.equal(s.all("grants")[0].revokedAt > 0, true);
  assert.equal(s.get("deletions", "old-delete").state, "recovery-invalidated");
  assert.equal(s.get("exports", "old-export").state, "recovery-suspended");
  assert.equal(s.all("holds")[0].state, f.store.all("holds")[0].state);
  assert.equal(s.all("holds")[0].archiveProtection, "unconfirmed");
  assert.equal(s.all("heartbeats").length, 0);
  assert.equal(s.all("archive-checks").length, 0);
  assert.equal(s.get("cameras", "one").exportEnabled, false);
  assert.equal(s.get("policy", "ring").automatedExportsApproved, false);
  const j = s.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.job);
  assert.equal(j.state, "blocked");
  assert.equal(j.owner, null);
  assert.equal(j.lease, null);
  assert.deepEqual(
    JSON.parse(j.payload),
    JSON.parse(
      f.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(f.job)
        .payload,
    ),
  );
  const segment = s.get("segments", f.segmentId);
  assert.equal(segment.verified, false);
  assert.equal(segment.derivative, null);
  assert.equal(segment.receipt.immutableStorageVerified, false);
  assert.equal(s.timeline(f.owner, "one", 100, 200).coveredMs, 0);
  assert.equal(s.auditIntegrity().valid, true);
  assert.equal(s.auditIntegrity().count, f.checkpoint.audit.count + 1);
  assert.equal(inspectDatabase(f.target).signedExports, 1);
  const originalEvents = f.store.db
    .prepare("SELECT * FROM audit ORDER BY seq")
    .all();
  assert.deepEqual(
    s.db
      .prepare("SELECT * FROM audit WHERE seq<=? ORDER BY seq")
      .all(f.checkpoint.audit.count),
    originalEvents,
  );
  assert.equal(
    fs.statSync(path.join(f.target, "recovery-report.json")).mode & 0o077,
    0,
  );
});
test("recovery guard blocks transfers, releases, deletion, cache and playback work even after configuration is re-enabled", async (t) => {
  const f = await fixture(t);
  await prepareRecovery(f.restored, f.checkpoint, f.target, "CASE");
  const s = openCandidate(t, f);
  s.registerUser(f.owner);
  s.put("policy", "ring", {
    automatedExportsApproved: true,
    retentionApproved: true,
    inspectorApproved: true,
    decisionReference: "fixture",
  });
  s.put("cameras", "one", f.store.get("cameras", "one"));
  for (const action of ["export", "delete", "release", "grant"])
    assert.throws(
      () => s.authorize(f.owner, action, "one"),
      /RECOVERY_REVIEW_REQUIRED/,
    );
  assert.equal(scheduleRing(s), 0);
  assert.ok(
    s
      .deleteEligibility(s.get("segments", f.segmentId))
      .includes("RECOVERY_REVIEW_REQUIRED"),
  );
  assert.equal(eligible(s, f.segment, 3600000), false);
  await assert.rejects(
    transfer(s, {}, { payload: {} }),
    /RECOVERY_REVIEW_REQUIRED/,
  );
  await reconcileHolds(s, {
    independent: true,
    setHold() {
      throw Error("must not write to provider");
    },
  });
  s.enqueue({ kind: "pilot-import", cameraId: "one", file: "must-not-read" });
  s.enqueue({ kind: "playback-build", segmentId: f.segmentId });
  assert.equal(s.claim(), null);
  assert.throws(
    () =>
      require("../../security/server/playback.cjs").queuePlayback(
        s,
        f.owner,
        f.segmentId,
      ),
    /RECOVERY_REVIEW_REQUIRED/,
  );
});
test("recovery permits fresh exact-byte archive checks without restoring stale retention or access decisions", async (t) => {
  const f = await fixture(t);
  await prepareRecovery(f.restored, f.checkpoint, f.target, "CASE");
  const s = openCandidate(t, f),
    archive = new LocalArchive(path.join(f.target, "archive"));
  const file = archive.file(f.segment.receipt.objectKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, f.bytes, { mode: 0o600 });
  assert.equal(scheduleVerification(s), 1);
  const j = s.claim();
  assert.equal(j.payload.kind, "archive-verify");
  await processVerification(s, archive, j);
  assert.equal(s.timeline(f.owner, "one", 100, 200).coveredMs, 100);
  assert.equal(
    s.get("segments", f.segmentId).receipt.immutableStorageVerified,
    false,
  );
  assert.equal(s.user("owner"), null);
  assert.equal(s.recoveryPending(), true);
  // Historical signatures remain verifiable in a subsequent backup too.
  const next = await snapshot(f.target, path.join(f.root, "subsequent-backup"));
  assert.equal(next.manifest.database.signedExports, 1);
});
test("actual recovered worker runs only archive readback and reports recovery, with deletion/cache switches enabled", async (t) => {
  const f = await fixture(t);
  await prepareRecovery(f.restored, f.checkpoint, f.target, "CASE");
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: process.env.PATH,
        SECURITY_DATA_DIR: f.target,
        SECURITY_MIN_FREE_BYTES: "1000000000",
        SECURITY_ENABLE_PHYSICAL_DELETION: "true",
        SECURITY_ENABLE_CACHE_EVICTION: "true",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const s = openCandidate(t, f),
    j = s.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.job);
  assert.equal(j.state, "blocked");
  assert.equal(j.attempts, 1);
  assert.ok(
    s
      .get("heartbeats", "archive-worker")
      .faultCodes.includes("RECOVERY_REVIEW_REQUIRED"),
  );
  assert.equal(s.get("archive-checks", f.segmentId).state, "missing");
  assert.equal(s.get("segments", f.segmentId).verified, false);
  await verifySnapshot(f.restored, f.checkpoint.manifestSha256);
});
test("checkpoint mismatches, exposed/symlinked source files and existing targets fail before activation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareRecovery(
      f.restored,
      { ...f.checkpoint, audit: { head: "c".repeat(64), count: 1 } },
      f.target,
      "CASE",
    ),
    /CHECKPOINT_METADATA/,
  );
  assert.equal(fs.existsSync(f.target), false);
  await assert.rejects(
    prepareRecovery(f.restored, f.checkpoint, f.restored, "CASE"),
    /SEPARATE_RECOVERY_TARGET/,
  );
  const db = path.join(f.restored, "command.sqlite");
  fs.chmodSync(db, 0o644);
  await assert.rejects(
    prepareRecovery(f.restored, f.checkpoint, f.target, "CASE"),
    /PRIVATE_BACKUP_FILE/,
  );
  fs.chmodSync(db, 0o600);
  fs.renameSync(db, db + ".real");
  fs.symlinkSync(db + ".real", db);
  await assert.rejects(
    prepareRecovery(f.restored, f.checkpoint, f.target, "CASE"),
  );
  fs.unlinkSync(db);
  fs.renameSync(db + ".real", db);
  await prepareRecovery(f.restored, f.checkpoint, f.target, "CASE");
  await assert.rejects(
    prepareRecovery(f.restored, f.checkpoint, f.target, "CASE"),
    /EEXIST/,
  );
});
test("actual preparation SIGKILL after migration leaves a quarantined candidate and refuses automatic overwrite", async (t) => {
  const f = await fixture(t),
    modulePath = path.resolve(__dirname, "../../security/server/recovery.cjs"),
    child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs'); const {prepareRecovery}=require(process.argv[1]); prepareRecovery(process.argv[2],JSON.parse(fs.readFileSync(process.argv[3])),process.argv[4],'CRASH-DRILL',{onStage:async stage=>{if(stage==='migrated'){process.stdout.write('MIGRATED\\n');await new Promise(()=>{setInterval(()=>{},1000)});}}}).catch(()=>process.exit(1));`,
        modulePath,
        f.restored,
        f.checkpointFile,
        f.target,
      ],
      { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
    );
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("child did not reach migration")),
      10000,
    );
    child.stdout.once("data", (d) => {
      clearTimeout(timer);
      String(d).includes("MIGRATED")
        ? resolve()
        : reject(Error("unexpected stage"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("child exited before migration"));
    });
  });
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
  assert.throws(() => new Store(f.target), /RECOVERY_REVALIDATION_REQUIRED/);
  assert.equal(
    fs.existsSync(path.join(f.target, "recovery-report.json")),
    false,
  );
  await assert.rejects(
    prepareRecovery(f.restored, f.checkpoint, f.target, "CASE"),
    /EEXIST/,
  );
  await verifySnapshot(f.restored, f.checkpoint.manifestSha256);
});
test("recovery API exposes its pause, denies evidence releases, and suspended old exports remain unusable after the guard is removed in a fixture", async (t) => {
  const f = await fixture(t);
  await prepareRecovery(f.restored, f.checkpoint, f.target, "CASE");
  const s = openCandidate(t, f),
    archive = new LocalArchive(path.join(f.target, "archive"));
  s.registerUser(f.owner);
  const reserve = require("node:net").createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port,
    base = "http://127.0.0.1:" + port;
  await new Promise((r) => reserve.close(r));
  const server = createServer({
    store: s,
    archive,
    origin: base,
    authenticate: () => f.owner,
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const call = (route) => fetch(base + route);
  const response = await call("/api/overview"),
    overview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(overview));
  assert.equal(overview.recovery.pending, true);
  s.put("segments", f.segmentId, f.segment);
  assert.equal(
    (await call(`/api/media/${f.segmentId}/original?export=old-export`)).status,
    409,
  );
  // No release command exists: this direct test-only mutation checks defense in depth.
  s.put("recovery", "control", { state: "released" });
  assert.equal(
    (await call(`/api/media/${f.segmentId}/original?export=old-export`)).status,
    403,
  );
});
