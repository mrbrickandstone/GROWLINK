"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Store } = require("../../security/server/store.cjs");
const { Watchdog } = require("../../security/server/watchdog.cjs");
const {
  scheduleRing,
  assessPipelines,
  observePipelines,
  DAY,
  STEP,
  READY_LAG,
} = require("../../security/server/pipeline.cjs");
function fixture(t, age = 3600000) {
  let now = Date.parse("2026-10-15T23:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-pipeline-"));
  const store = new Store(root, { now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const camera = {
    id: "one",
    source: "ring",
    exportEnabled: true,
    enabledAt: now - age,
    continuousHistoryDays: 14,
    continuousHistoryEvidence: "Synthetic setting observation",
  };
  store.put("cameras", camera.id, camera);
  store.put("policy", "ring", {
    automatedExportsApproved: true,
    decisionReference: "synthetic-policy-only",
  });
  return {
    root,
    store,
    camera,
    now: () => now,
    advance: (value) => (now += value),
  };
}
function segments(store, camera, start, end, patch = {}) {
  const id = "segment-" + start;
  store.put("segments", id, {
    id,
    cameraId: camera.id,
    start,
    end,
    verified: true,
    ...patch,
    receipt: {
      independent: true,
      ...patch.receipt,
      readbackVerifiedAt: store.now(),
    },
  });
}
test("scheduler cursor creates stable bounded windows across restart and continued catch-up", (t) => {
  const f = fixture(t, 3 * DAY);
  assert.equal(scheduleRing(f.store, { batchPerCamera: 2 }), 2);
  const first = f.store.db
    .prepare("SELECT id,payload FROM jobs ORDER BY rowid")
    .all();
  const restart = spawnSync(
    process.execPath,
    [
      "-e",
      "const {Store}=require(process.argv[1]); const {scheduleRing}=require(process.argv[2]); const s=new Store(process.argv[3],{now:()=>Number(process.argv[4])}); try{console.log(scheduleRing(s,{batchPerCamera:2}));}finally{s.close();}",
      path.resolve(__dirname, "../../security/server/store.cjs"),
      path.resolve(__dirname, "../../security/server/pipeline.cjs"),
      f.root,
      String(f.now()),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(restart.status, 0);
  assert.equal(restart.stdout.trim(), "2");
  assert.deepEqual(
    f.store.db
      .prepare("SELECT id,payload FROM jobs ORDER BY rowid LIMIT 2")
      .all(),
    first,
  );
  const jobs = f.store.db
    .prepare("SELECT payload FROM jobs ORDER BY rowid")
    .all()
    .map((r) => JSON.parse(r.payload));
  assert.equal(jobs[0].requestStart, f.camera.enabledAt);
  for (let i = 1; i < jobs.length; i++) {
    assert.equal(jobs[i].requestStart, jobs[i - 1].requestEnd - 1000);
    assert.equal(jobs[i].requestEnd - jobs[i].requestStart, 300000);
  }
  assert.equal(
    f.store.get("schedules", "one").nextStart,
    f.camera.enabledAt + 4 * STEP,
  );
  f.advance(STEP);
  assert.equal(scheduleRing(f.store, { batchPerCamera: 2 }), 2);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs").get().n, 6);
});
test("scheduler transaction rolls back jobs and cursor together, and policy/configuration changes cannot erase obligations", (t) => {
  const f = fixture(t),
    enqueue = f.store.enqueue.bind(f.store);
  let calls = 0;
  f.store.enqueue = (payload) => {
    if (++calls === 2) throw Error("simulated interruption");
    return enqueue(payload);
  };
  assert.throws(() => scheduleRing(f.store), /simulated interruption/);
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.store.get("schedules", "one"), null);
  assert.equal(f.store.auditIntegrity().count, 0);
  f.store.enqueue = enqueue;
  scheduleRing(f.store);
  const count = f.store.jobs().length,
    cursor = f.store.get("schedules", "one");
  assert.equal(scheduleRing(f.store), 0);
  f.store.put("policy", "ring", { automatedExportsApproved: false });
  f.advance(DAY);
  assert.equal(scheduleRing(f.store), 0);
  assert.equal(f.store.jobs().length, count);
  f.store.put("cameras", "one", { ...f.camera, enabledAt: f.now() - 600000 });
  assert.deepEqual(f.store.get("schedules", "one"), cursor);
  assert.deepEqual(assessPipelines(f.store)[0].faultCodes, [
    "PIPELINE_CONFIGURATION_INVALID",
  ]);
});
test("old unscheduled footage remains an explicit gap after the advertised retrieval window", (t) => {
  const f = fixture(t, 20 * DAY);
  scheduleRing(f.store, { batchPerCamera: 1 });
  const cursor = f.store.get("schedules", "one"),
    row = observePipelines(f.store).rows[0];
  assert.equal(cursor.lastSkipped.start, f.camera.enabledAt);
  assert.ok(cursor.lastSkipped.end > f.camera.enabledAt);
  assert.equal(row.originals.oldestMissingAt, f.camera.enabledAt);
  assert.equal(row.status, "outside_window");
  assert.ok(row.faultCodes.includes("SOURCE_WINDOW_EXCEEDED"));
  assert.ok(
    f.store
      .auditLog()
      .some((r) => r.event.action === "schedule.unretrieved.interval"),
  );
  assert.equal(f.store.auditIntegrity().valid, true);
});
test("actual intervals reveal partial complete jobs, while local originals and playback failures have separate risks", (t) => {
  const f = fixture(t, 13 * DAY),
    ready = assessPipelines(f.store)[0].readyThrough;
  scheduleRing(f.store, { batchPerCamera: 1 });
  const job = f.store.claim();
  f.store.finish(job, "complete");
  segments(f.store, f.camera, f.camera.enabledAt + 33, ready, {
    receipt: { independent: false },
    derivative: null,
  });
  let row = assessPipelines(f.store)[0];
  assert.equal(row.originals.missingMs, 33);
  assert.equal(row.status, "at_risk");
  assert.ok(row.archive.missingMs > 33);
  segments(f.store, f.camera, f.camera.enabledAt, f.camera.enabledAt + 33, {
    receipt: { independent: false },
  });
  row = assessPipelines(f.store)[0];
  assert.equal(row.originals.missingMs, 0);
  assert.equal(row.sourceWindowBoundaryAt, null);
  assert.ok(!row.faultCodes.includes("SOURCE_WINDOW_AT_RISK"));
  assert.ok(row.faultCodes.includes("ARCHIVE_BACKLOG"));
  for (const s of f.store.all("segments"))
    f.store.put("segments", s.id, {
      ...s,
      receipt: { ...s.receipt, independent: true },
    });
  const derivativeJob = f.store.enqueue({
    kind: "ring-export",
    cameraId: "one",
    requestStart: ready - STEP,
    requestEnd: ready,
  });
  f.store.put("segments", derivativeJob, {
    id: derivativeJob,
    cameraId: "one",
    start: ready - STEP,
    end: ready,
    verified: true,
    receipt: { independent: true, readbackVerifiedAt: f.store.now() },
    derivative: null,
  });
  f.store.db
    .prepare("UPDATE jobs SET state='failed' WHERE id=?")
    .run(derivativeJob);
  row = assessPipelines(f.store)[0];
  assert.equal(row.archive.missingMs, 0);
  assert.deepEqual(row.faultCodes, ["PLAYBACK_BACKLOG"]);
});
test("configured short history changes the risk estimate; unknown settings and unverified recordings cannot report current", (t) => {
  const f = fixture(t, 21 * 3600000);
  f.store.put("cameras", "one", { ...f.camera, continuousHistoryDays: 1 });
  let row = assessPipelines(f.store)[0];
  assert.equal(row.status, "at_risk");
  assert.equal(row.sourceWindowRemainingMs, 3 * 3600000);
  f.advance(4 * 3600000);
  assert.equal(assessPipelines(f.store)[0].status, "outside_window");
  f.store.put("cameras", "one", {
    ...f.camera,
    continuousHistoryDays: undefined,
    continuousHistoryEvidence: undefined,
  });
  row = assessPipelines(f.store)[0];
  assert.equal(row.historyBasis, "advertised-maximum-only");
  assert.ok(row.faultCodes.includes("SOURCE_WINDOW_UNCONFIRMED"));
  segments(f.store, f.camera, f.camera.enabledAt, row.readyThrough, {
    verified: false,
  });
  assert.ok(assessPipelines(f.store)[0].originals.missingMs > 0);
  const invalidReceipt = f.store.all("segments")[0];
  for (const readbackVerifiedAt of [null, f.now() + DAY]) {
    f.store.put("segments", invalidReceipt.id, {
      ...invalidReceipt,
      verified: true,
      receipt: { independent: true, readbackVerifiedAt },
    });
    assert.ok(assessPipelines(f.store)[0].originals.missingMs > 0);
  }
  for (let i = 0; i < 150; i++)
    f.store.enqueue({
      kind: "ring-export",
      cameraId: "one",
      requestStart: i,
      requestEnd: i + 1,
    });
  assert.equal(assessPipelines(f.store)[0].jobs.pending, 150);
});
test("monitoring excludes aged-out target intervals but includes older investigation holds", (t) => {
  const f = fixture(t, 100 * DAY),
    start = f.now() - 90 * DAY;
  const ready = assessPipelines(f.store)[0].readyThrough;
  segments(f.store, f.camera, start, ready);
  assert.equal(assessPipelines(f.store)[0].status, "current");
  f.store.put("holds", "old-hold", {
    id: "old-hold",
    cameraId: "one",
    state: "active",
    start: f.now() - 95 * DAY,
    end: f.now() - 95 * DAY + 60000,
  });
  let row = assessPipelines(f.store)[0];
  assert.equal(row.originals.missingMs, 60000);
  assert.equal(row.requiredWindows.length, 2);
  assert.equal(row.status, "outside_window");
  f.store.put("holds", "old-hold", {
    ...f.store.get("holds", "old-hold"),
    state: "released",
  });
  assert.equal(assessPipelines(f.store)[0].status, "current");
});
test("watchdog retries an escalation with stable identity across restart, never equating acceptance with delivery", async (t) => {
  const f = fixture(t),
    sent = [];
  let fail = false;
  const notify = async (payload) => {
    sent.push(payload);
    if (fail) throw Error("fixture failure");
    return { accepted: true };
  };
  let dog = new Watchdog(f.store, { notify });
  dog.heartbeat("archive-worker", "failed", ["ARCHIVE_BACKLOG"]);
  await dog.tick();
  assert.equal(sent.length, 1);
  f.advance(30000);
  dog.heartbeat("archive-worker", "failed", ["ARCHIVE_BACKLOG"]);
  await dog.tick();
  assert.equal(sent.length, 1);
  fail = true;
  f.advance(30000);
  dog.heartbeat("archive-worker", "failed", [
    "ARCHIVE_BACKLOG",
    "SOURCE_WINDOW_AT_RISK",
  ]);
  await dog.tick();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].id, sent[0].id);
  dog = new Watchdog(f.store, { notify });
  fail = false;
  f.advance(30000);
  await dog.tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[1].id, sent[2].id);
  const incident = f.store.get("incidents", "archive-worker");
  assert.equal(incident.revision, 2);
  assert.equal(incident.priorDispatches.length, 1);
  assert.equal(incident.deliveryWithinFiveMinutes, null);
  assert.ok(incident.providerAcceptedAt - incident.revisionFaultAt < 300000);
  assert.throws(
    () => dog.heartbeat("archive-worker", "ok", ["ARCHIVE_BACKLOG"]),
    /INVALID_HEARTBEAT/,
  );
  assert.throws(
    () => dog.heartbeat("archive-worker", "failed", ["untrusted detail"]),
    /INVALID_HEARTBEAT/,
  );
});
test("a real worker process records backlog and policy faults without requesting Ring footage", (t) => {
  const f = fixture(t, 2 * DAY);
  f.store.put("policy", "ring", { automatedExportsApproved: false });
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: process.env.PATH,
        SECURITY_DATA_DIR: f.root,
        SECURITY_MIN_FREE_BYTES: "1000000000",
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(run.status, 0);
  const h = f.store.get("heartbeats", "archive-worker");
  assert.equal(h.status, "failed");
  assert.ok(h.faultCodes.includes("RING_EXPORT_POLICY_BLOCKED"));
  assert.ok(h.faultCodes.includes("ORIGINAL_BACKLOG"));
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.store.get("pipeline-health", "one").configured, true);
});
