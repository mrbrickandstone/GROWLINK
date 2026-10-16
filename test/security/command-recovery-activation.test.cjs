"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { once } = require("node:events");
const { Store } = require("../../security/server/store.cjs"),
  { snapshot, verifySnapshot } = require("../../security/server/backup.cjs"),
  { prepareRecovery } = require("../../security/server/recovery.cjs"),
  activation = require("../../security/server/recovery-activation.cjs"),
  { createServer } = require("../../security/server/http.cjs"),
  { LocalArchive } = require("../../security/server/archive.cjs");
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-activation-")),
    source = new Store(path.join(root, "source"));
  const owner = {
    id: "owner",
    name: "Recovery owner",
    role: "owner",
    cameraIds: ["*"],
    mfa: true,
    csrf: "fixture",
  };
  source.registerUser(owner);
  source.put("cameras", "one", {
    id: "one",
    name: "One",
    source: "ring",
    room: "FLOWERING",
    exportEnabled: true,
  });
  const ringJob = source.enqueue({
    kind: "ring-export",
    cameraId: "one",
    requestStart: 1000,
    requestEnd: 2000,
  });
  source.claim();
  const oldExport = source.enqueue({
    kind: "evidence-export",
    exportId: "old",
  });
  source.put("exports", "old", {
    id: "old",
    state: "queued",
    createdBy: owner.id,
  });
  source.put("deletions", "old", {
    id: "old",
    state: "approved",
    approvedBy: "other",
  });
  source.put("grants", "old", { id: "old", userId: "inspector" });
  source.session(
    "old",
    { kind: "user", userId: owner.id },
    Date.now() + 600000,
  );
  const saved = await snapshot(source.root, path.join(root, "restored"));
  const checkpoint = {
    schema: "farber-backup-checkpoint-v1",
    snapshotId: "f".repeat(64),
    manifestSha256: saved.manifestSha256,
    createdAt: saved.manifest.createdAt,
    audit: saved.manifest.database.audit,
    restoreVerified: true,
  };
  source.close();
  const target = path.join(root, "review");
  await prepareRecovery(
    path.join(root, "restored"),
    checkpoint,
    target,
    "SYNTHETIC-RECOVERY",
  );
  const store = new Store(target);
  store.registerUser(owner);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = {
    reconciled: true,
    references: Object.fromEntries(
      [
        "checkpoint",
        "changesAndHolds",
        "identities",
        "sourcePolicy",
        "hostAndStorage",
        "notificationReceipt",
      ].map((k) => [k, "SYNTHETIC-" + k]),
    ),
  };
  return { root, target, store, owner, input, ringJob, oldExport, checkpoint };
}
function activate(f, plan) {
  return activation.activate(f.store, f.owner, {
    planId: plan.id,
    confirmation: "ACTIVATE RECOVERY",
  });
}
test("recovery activation resumes only reviewed eligible jobs, preserves request identity and keeps old access invalid", async (t) => {
  const f = await fixture(t),
    s = f.store;
  s.put("cameras", "one", { ...s.get("cameras", "one"), exportEnabled: true });
  s.put("policy", "ring", {
    automatedExportsApproved: true,
    decisionReference: "SYNTHETIC-POLICY",
  });
  const plan = activation.review(s, f.owner, f.input),
    result = activate(f, plan);
  assert.deepEqual(result.counts, {
    resumed: 1,
    retiredRequests: 1,
    stillPaused: 0,
  });
  assert.equal(s.recoveryPending(), false);
  const job = s.db.prepare("SELECT * FROM jobs WHERE id=?").get(f.ringJob);
  assert.equal(job.state, "queued");
  assert.equal(job.attempts, 1);
  assert.deepEqual(JSON.parse(job.payload), {
    kind: "ring-export",
    cameraId: "one",
    requestStart: 1000,
    requestEnd: 2000,
  });
  assert.equal(s.get("exports", "old").state, "recovery-suspended");
  assert.equal(s.get("deletions", "old").state, "recovery-invalidated");
  assert.ok(s.get("grants", "old").revokedAt);
  assert.equal(s.getSession("old"), null);
  assert.equal(result.productionReady, false);
  assert.equal(s.get("recovery", "control").newestSnapshotVerified, false);
  const head = s.auditIntegrity().head;
  assert.deepEqual(activate(f, plan), result);
  assert.equal(s.auditIntegrity().head, head);
  // A second connection after restart sees the committed decision and same job.
  const restarted = new Store(f.target);
  assert.equal(restarted.recoveryPending(), false);
  assert.equal(restarted.claim().id, f.ringJob);
  restarted.close();
  await verifySnapshot(
    path.join(f.root, "restored"),
    f.checkpoint.manifestSha256,
  );
});
test("activation requires current named owner, MFA, all-camera scope and exact confirmation", async (t) => {
  const f = await fixture(t);
  const otherOwner = { ...f.owner, id: "other-owner" };
  f.store.registerUser(otherOwner);
  for (const actor of [
    null,
    { ...f.owner, mfa: false },
    { ...f.owner, readOnly: true },
    { ...f.owner, id: "unknown" },
  ])
    assert.throws(
      () => activation.status(f.store, actor),
      /RECOVERY_NAMED_OWNER_MFA/,
    );
  const plan = activation.review(f.store, f.owner, f.input);
  assert.throws(
    () =>
      activation.activate(f.store, otherOwner, {
        planId: plan.id,
        confirmation: "ACTIVATE RECOVERY",
      }),
    /REVIEW_NOT_FOUND/,
  );
  assert.throws(
    () => activation.activate(f.store, f.owner, {}),
    /REVIEW_NOT_FOUND/,
  );
  assert.throws(
    () =>
      activation.activate(f.store, f.owner, {
        planId: plan.id,
        confirmation: "yes",
      }),
    /CONFIRMATION/,
  );
  f.store.registerUser({ ...f.owner, role: "operator" });
  assert.throws(() => activate(f, plan), /NAMED_OWNER/);
  f.store.registerUser({ ...f.owner, cameraIds: ["different"] });
  assert.throws(() => activate(f, plan), /ALL_CAMERAS/);
  f.store.registerUser({ ...f.owner, enabled: false });
  assert.throws(() => activate(f, plan), /NAMED_OWNER/);
});
test("stale, expired, malformed and concurrently running recovery reviews cannot activate", async (t) => {
  const f = await fixture(t),
    s = f.store;
  assert.throws(
    () => activation.review(s, f.owner, { ...f.input, reconciled: false }),
    /ATTESTATION/,
  );
  assert.throws(
    () => activation.review(s, f.owner, { ...f.input, references: {} }),
    /REFERENCE/,
  );
  assert.throws(
    () =>
      activation.review(s, f.owner, {
        ...f.input,
        controlDataLoss: { start: 0, end: 1, incidentReference: "x" },
      }),
    /LOSS_INTERVAL/,
  );
  const plan = activation.review(s, f.owner, f.input);
  s.addHold(f.owner, {
    cameraId: "one",
    start: 1000,
    end: 2000,
    caseReference: "NEW",
    reason: "Recovered post-backup hold",
  });
  assert.throws(() => activate(f, plan), /STALE/);
  const newer = activation.review(s, f.owner, f.input),
    now = s.now;
  s.now = () => newer.expiresAt;
  assert.throws(() => activate(f, newer), /EXPIRED/);
  s.now = now;
  const job = s.enqueue({ kind: "archive-verify", segmentId: "a".repeat(64) });
  s.claim();
  assert.throws(() => activation.review(s, f.owner, f.input), /STOP_WORKER/);
  s.db.prepare("DELETE FROM jobs WHERE id=?").run(job);
  s.enqueue({ kind: "pilot-import", file: "never-read", cameraId: "one" });
  assert.throws(
    () => activation.review(s, f.owner, f.input),
    /UNREVIEWED_JOBS/,
  );
  assert.equal(s.recoveryPending(), true);
});
test("unverified originals require explicit incident review and retain gaps after activation", async (t) => {
  const f = await fixture(t),
    s = f.store,
    id = "a".repeat(64);
  s.put("segments", id, {
    id,
    cameraId: "one",
    start: 1000,
    end: 2000,
    verified: false,
  });
  assert.throws(() => activation.review(s, f.owner, f.input), /REFERENCE/);
  assert.throws(
    () =>
      activation.review(s, f.owner, {
        ...f.input,
        exceptionReference: "INCIDENT",
      }),
    /ORIGINALS/,
  );
  const lossStart = Date.parse(s.get("recovery", "control").sourceCreatedAt);
  s.now = () => lossStart + 10000;
  const plan = activation.review(s, f.owner, {
    ...f.input,
    exceptionReference: "INCIDENT",
    acceptExceptions: true,
    controlDataLoss: {
      start: lossStart,
      end: lossStart + 9000,
      incidentReference: "CONTROL-LOSS",
    },
  });
  const result = activate(f, plan);
  assert.equal(result.exceptionCount, 1);
  assert.equal(result.controlDataLoss.incidentReference, "CONTROL-LOSS");
  assert.equal(result.counts.stillPaused, 1);
  assert.equal(s.get("segments", id).verified, false);
  assert.equal(s.timeline(f.owner, "one", 1000, 2000).coveredMs, 0);
  assert.equal(
    s.get("recovery-reviews", plan.id).exceptions[0].incidentReference,
    "INCIDENT",
  );
});
test("fresh readback expiry and changed permissions invalidate pending activation", async (t) => {
  const f = await fixture(t),
    s = f.store,
    id = "a".repeat(64);
  const at = s.get("recovery", "control").preparedAt;
  s.now = () => at + 24 * 3600000 - 1000;
  s.put("segments", id, {
    id,
    cameraId: "one",
    start: 1000,
    end: 2000,
    verified: true,
    receipt: { independent: true, readbackVerifiedAt: at },
  });
  const plan = activation.review(s, f.owner, f.input);
  s.now = () => at + 24 * 3600000 + 1;
  assert.throws(() => activate(f, plan), /READBACK_EXPIRED/);
  s.now = () => at + 1000;
  const next = activation.review(s, f.owner, f.input);
  s.registerUser({
    id: "new",
    name: "New",
    role: "operator",
    cameraIds: ["one"],
  });
  assert.throws(() => activate(f, next), /STALE/);
});
test("activation rolls back atomically on an audit write failure and can be retried", async (t) => {
  const f = await fixture(t),
    s = f.store,
    plan = activation.review(s, f.owner, f.input),
    audit = s.audit;
  s.audit = () => {
    throw Error("SIMULATED_DISK_WRITE_FAILURE");
  };
  assert.throws(() => activate(f, plan), /SIMULATED/);
  s.audit = audit;
  assert.equal(s.recoveryPending(), true);
  assert.equal(
    s.db.prepare("SELECT state FROM jobs WHERE id=?").get(f.oldExport).state,
    "blocked",
  );
  assert.equal(s.get("recovery-reviews", plan.id).state, "reviewed");
  activate(f, plan);
  assert.equal(s.auditIntegrity().valid, true);
});
test("actual activation SIGKILL before commit leaves the guard and jobs unchanged", async (t) => {
  const f = await fixture(t),
    plan = activation.review(f.store, f.owner, f.input);
  const code = `const {Store}=require(process.argv[1]); const a=require(process.argv[2]);
    const s=new Store(process.argv[3]), actor=JSON.parse(process.argv[4]);
    const audit=s.audit.bind(s); s.audit=(...args)=>{audit(...args); if(args[1]==='recovery.activated')process.kill(process.pid,'SIGKILL');};
    a.activate(s,actor,{planId:process.argv[5],confirmation:'ACTIVATE RECOVERY'});`;
  const run = require("node:child_process").spawnSync(
    process.execPath,
    [
      "-e",
      code,
      path.resolve(__dirname, "../../security/server/store.cjs"),
      path.resolve(__dirname, "../../security/server/recovery-activation.cjs"),
      f.target,
      JSON.stringify(f.owner),
      plan.id,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 10000 },
  );
  assert.equal(run.signal, "SIGKILL");
  assert.equal(f.store.recoveryPending(), true);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(f.oldExport)
      .state,
    "blocked",
  );
  assert.equal(f.store.get("recovery-reviews", plan.id).state, "reviewed");
  assert.equal(f.store.auditIntegrity().valid, true);
  activate(f, plan);
  assert.equal(f.store.recoveryPending(), false);
});
test("a later recovery preserves the previous activation and disarms the next backup again", async (t) => {
  const f = await fixture(t),
    s = f.store;
  activate(f, activation.review(s, f.owner, f.input));
  const saved = await snapshot(f.target, path.join(f.root, "second-restore"));
  const checkpoint = {
    ...f.checkpoint,
    manifestSha256: saved.manifestSha256,
    createdAt: saved.manifest.createdAt,
    audit: saved.manifest.database.audit,
  };
  const report = await prepareRecovery(
    path.join(f.root, "second-restore"),
    checkpoint,
    path.join(f.root, "second-review"),
    "SECOND-CASE",
  );
  const second = new Store(path.join(f.root, "second-review"));
  try {
    assert.equal(second.recoveryPending(), true);
    assert.equal(second.user(f.owner.id), null);
    assert.equal(report.previousRecoveryId, s.get("recovery", "control").id);
    assert.ok(
      second
        .all("recovery-history")
        .some((h) => h.kind === "recovery" && h.value.activation),
    );
    assert.equal(second.get("exports", "old").recoveryPreviousState, "queued");
    assert.equal(
      second.db.prepare("SELECT state FROM jobs WHERE id=?").get(f.oldExport)
        .state,
      "recovery-retired",
    );
  } finally {
    second.close();
  }
});
test("recovery HTTP flow enforces CSRF, owner scope and stale review checks", async (t) => {
  const f = await fixture(t),
    s = f.store;
  // Reserve an actual loopback port so Host and Origin checks use the exact URL.
  const reserve = require("node:net").createServer().listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer({
    store: s,
    archive: new LocalArchive(path.join(f.root, "archive")),
    origin,
    env: {},
    authenticate: () => f.owner,
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const post = async (route, body, csrf = "fixture") =>
    fetch(origin + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/api/recovery/review", f.input, "bad")).status,
    403,
  );
  const reviewed = await post("/api/recovery/review", f.input);
  assert.equal(reviewed.status, 201);
  const plan = await reviewed.json();
  const released = await post("/api/recovery/activate", {
    planId: plan.id,
    confirmation: "ACTIVATE RECOVERY",
  });
  assert.equal(released.status, 201);
  assert.equal((await released.json()).productionReady, false);
  assert.equal(
    (await (await fetch(origin + "/api/recovery")).json()).pending,
    false,
  );
  s.registerUser({ ...f.owner, role: "operator" });
  assert.equal((await fetch(origin + "/api/recovery")).status, 403);
});
