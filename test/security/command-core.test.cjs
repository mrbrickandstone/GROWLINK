"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Store, DAY } = require("../../security/server/store.cjs");
const {
  LocalArchive,
  S3Archive,
} = require("../../security/server/archive.cjs");
const { evidence } = require("../../security/server/evidence.cjs");
const { Watchdog } = require("../../security/server/watchdog.cjs");
const { executeDeletion } = require("../../security/server/deletion.cjs");
const { reconcile } = require("../../security/server/transfer.cjs");
const owner = {
    id: "owner-a",
    name: "Owner A",
    role: "owner",
    cameraIds: ["*"],
    mfa: true,
  },
  other = { ...owner, id: "owner-b", name: "Owner B" },
  operator = { id: "op", role: "operator", cameraIds: ["one"] },
  inspector = {
    id: "insp",
    name: "Inspector",
    role: "inspector",
    cameraIds: ["one"],
  };
function setup(t) {
  let now = Date.parse("2026-10-13T19:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-control-")),
    store = new Store(root, { now: () => now });
  for (const u of [owner, other, inspector]) store.registerUser(u);
  store.put("cameras", "one", {
    id: "one",
    name: "One",
    source: "ring",
    location: "Farber",
    room: "Unassigned",
  });
  store.put("cameras", "two", {
    id: "two",
    name: "Two",
    source: "ring",
    location: "Farber",
    room: "Unassigned",
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, root, advance: (n) => (now += n) };
}
function segment(store, patch = {}) {
  const s = {
    id: "a".repeat(64),
    cameraId: "one",
    source: "ring",
    start: store.now() - 2000,
    end: store.now() - 1000,
    requested: { start: store.now() - 2000, end: store.now() - 1000 },
    verified: true,
    sha256: "b".repeat(64),
    bytes: 5,
    ingestedAt: store.now(),
    provenance: "vendor-delivered",
    receipt: {
      independent: false,
      immutableStorageVerified: false,
      retainUntil: store.now() + 90 * DAY,
    },
    ...patch,
  };
  store.put("segments", s.id, s);
  return s;
}
test("named roles, camera scope, owner MFA and read-only review fail closed", (t) => {
  const { store } = setup(t);
  assert.throws(() => store.authorize(null, "read"), /SIGN_IN/);
  assert.throws(
    () => store.authorize({ ...owner, mfa: false }, "hold", "one"),
    /MFA/,
  );
  assert.throws(() => store.authorize(operator, "read", "two"), /SCOPE/);
  assert.throws(
    () => store.authorize({ ...operator, readOnly: true }, "hold", "one"),
    /READ_ONLY/,
  );
  assert.throws(
    () =>
      store.authorize(
        { id: "tech", role: "technician", cameraIds: ["*"] },
        "export",
        "one",
      ),
    /ROLE/,
  );
  assert.equal(store.authorize(operator, "hold", "one"), true);
  store.registerUser({ ...owner, role: "auditor" });
  assert.throws(
    () =>
      store.authorize({ ...owner, externalAuthenticated: true }, "hold", "one"),
    /ROLE/,
  );
});
test("pending holds apply to late arrivals, survive reopening, and require owner release", (t) => {
  const { store, root } = setup(t);
  const h = store.addHold(operator, {
    cameraId: "one",
    start: store.now() - 3000,
    end: store.now(),
    reason: "Investigation",
    caseReference: "CASE-1",
  });
  const s = segment(store);
  assert.equal(store.held(s)[0].state, "pending");
  const second = new Store(root);
  assert.equal(second.held(s).length, 1);
  second.close();
  assert.throws(() => store.releaseHold(operator, h.id, "done"), /ROLE/);
  store.releaseHold(owner, h.id, "Reviewed case closure");
  assert.equal(store.held(s).length, 0);
  assert.equal(store.auditIntegrity().valid, true);
});
test("inspector grants require policy clearance, exact file bounds, expiry and immediate revocation", (t) => {
  const { store, advance } = setup(t);
  const input = {
    userId: inspector.id,
    requestId: "OCM-request-1",
    purpose: "Requested footage",
    cameraIds: ["one"],
    start: 100,
    end: 200,
    expiresAt: store.now() + 60000,
  };
  assert.throws(() => store.grant(owner, input), /POLICY/);
  store.put("policy", "ring", {
    inspectorApproved: true,
    decisionReference: "Written clearance fixture",
  });
  const g = store.grant(owner, input);
  assert.equal(
    store.authorize(inspector, "playback", "one", { start: 100, end: 200 }),
    true,
  );
  assert.throws(
    () =>
      store.authorize(inspector, "playback", "one", { start: 99, end: 200 }),
    /GRANT/,
  );
  store.revoke(owner, g.id);
  assert.throws(
    () =>
      store.authorize(inspector, "playback", "one", { start: 100, end: 200 }),
    /GRANT/,
  );
  store.grant(owner, input);
  advance(60001);
  assert.throws(
    () =>
      store.authorize(inspector, "playback", "one", { start: 100, end: 200 }),
    /GRANT/,
  );
});
test("retention floor, two distinct owners and a newly arriving hold gate deletion at execution", async (t) => {
  const { store, advance } = setup(t);
  const s = segment(store, {
    receipt: {
      independent: true,
      immutableStorageVerified: true,
      retainUntil: store.now() + 90 * DAY,
    },
  });
  store.put("policy", "ring", { retentionApproved: true });
  const r = store.requestDelete(owner, s.id, "Retention elapsed");
  assert.throws(() => store.approveDelete(owner, r.id), /SECOND/);
  assert.throws(() => store.approveDelete(other, r.id), /RETENTION/);
  advance(91 * DAY);
  store.approveDelete(other, r.id);
  const hold = store.addHold(operator, {
    cameraId: "one",
    start: s.start,
    end: s.end,
    reason: "Late investigation",
    caseReference: "LATE",
  });
  let removed = 0;
  await assert.rejects(
    executeDeletion(store, { remove: async () => removed++ }, r.id),
    /HOLD/,
  );
  assert.equal(removed, 0);
  store.releaseHold(owner, hold.id, "Authorized release");
  await executeDeletion(store, { remove: async () => removed++ }, r.id);
  assert.equal(removed, 1);
  assert.equal(store.get("segments", s.id).verified, false);
});
test("archive upload is idempotent, readback detects tampering and reconciliation removes coverage credit", async (t) => {
  const { store, root } = setup(t);
  const file = path.join(root, "input.mp4");
  fs.writeFileSync(file, "fixture-original");
  const sha = crypto
      .createHash("sha256")
      .update("fixture-original")
      .digest("hex"),
    archive = new LocalArchive(path.join(root, "destination"));
  const receipt = await archive.put(file, sha, 16, store.now() + 90 * DAY);
  assert.equal(receipt.independent, false);
  assert.deepEqual(
    (await archive.put(file, sha, 16, receipt.retainUntil)).objectKey,
    receipt.objectKey,
  );
  const job = store.enqueue({ kind: "fixture" }),
    claimed = store.claim();
  store.finish(claimed, "complete");
  segment(store, { id: job, receipt, sha256: sha, bytes: 16 });
  assert.equal(
    store.timeline(operator, "one", store.now() - 3000, store.now()).coveredMs,
    1000,
  );
  fs.writeFileSync(archive.file(receipt.objectKey), "altered");
  assert.equal(await archive.verify(receipt), false);
  assert.equal((await reconcile(store, archive)).invalid, 1);
  assert.equal(
    store.timeline(operator, "one", store.now() - 3000, store.now()).coveredMs,
    0,
  );
  assert.equal(store.jobs()[0].state, "queued");
});
test("signed evidence manifests disclose gaps and native-authentication limits, and reject changed originals", async (t) => {
  const { store, root } = setup(t);
  const f = path.join(root, "original.mp4");
  fs.writeFileSync(f, "original");
  const sha = crypto.createHash("sha256").update("original").digest("hex"),
    archive = new LocalArchive(path.join(root, "archive"));
  const receipt = await archive.put(f, sha, 8, store.now() + 90 * DAY);
  const s = segment(store, { sha256: sha, bytes: 8, receipt });
  const out = await evidence(store, archive, operator, {
    cameraId: "one",
    start: s.start - 33,
    end: s.end,
    requestId: "REQ-1",
    purpose: "Internal investigation",
  });
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(out.manifestText),
      out.publicKey,
      Buffer.from(out.signature, "base64"),
    ),
    true,
  );
  const manifest = JSON.parse(out.manifestText);
  assert.equal(manifest.cameraNativeAuthentication, "unverified");
  assert.equal(
    manifest.coverage.gaps[0].end - manifest.coverage.gaps[0].start,
    33,
  );
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(out.manifestText + "x"),
      out.publicKey,
      Buffer.from(out.signature, "base64"),
    ),
    false,
  );
  fs.writeFileSync(archive.file(receipt.objectKey), "changed!");
  await assert.rejects(
    evidence(store, archive, operator, {
      cameraId: "one",
      start: s.start,
      end: s.end,
      requestId: "REQ-2",
      purpose: "Changed object",
    }),
    /READBACK/,
  );
});
test("durable leases reject stale worker completion and reclaim unchanged jobs after expiry", (t) => {
  const { store, advance } = setup(t);
  const input = {
    kind: "ring-export",
    cameraId: "one",
    requestStart: 100,
    requestEnd: 200,
  };
  const id = store.enqueue(input);
  assert.equal(store.enqueue(input), id);
  const first = store.claim();
  assert.equal(store.claim(), null);
  advance(600001);
  const second = store.claim();
  assert.equal(second.id, id);
  assert.deepEqual(second.payload, input);
  assert.equal(second.attempts, 2);
  assert.throws(() => store.finish(first, "complete"), /LEASE_LOST/);
  store.finish(second, "complete");
  assert.equal(store.jobs()[0].state, "complete");
});
test("camera permissions alone never show verified access or continuous retention", (t) => {
  const { store } = setup(t);
  const c = store.cameraStatus(operator, store.get("cameras", "one"));
  assert.equal(c.capture.state, "unknown");
  assert.equal(c.archive.state, "unknown");
  assert.equal(c.access.state, "unknown");
  assert.equal(c.retention.state, "degraded");
});
test("inspection and power records preserve measured outcomes rather than invented eight-hour passes", (t) => {
  const { store } = setup(t);
  const input = {
    cameraIds: ["one"],
    performedAt: store.now() - 600 * 60000,
    notes: "Test evidence",
    evidenceReference: "local-test-fixture",
  };
  const a = store.record(operator, {
    ...input,
    kind: "inspection",
    result: "defects",
  });
  assert.equal(a.nextDueAt - a.performedAt, 30 * DAY);
  const b = store.record(operator, {
    ...input,
    kind: "power",
    loadWatts: 250,
    runtimeMinutes: 479,
    equipment: "Fixture UPS",
    continuityVerified: true,
  });
  assert.equal(b.result, "incomplete");
  assert.throws(
    () =>
      store.record(operator, {
        ...input,
        kind: "power",
        performedAt: store.now(),
        loadWatts: 250,
        runtimeMinutes: 480,
        equipment: "UPS",
        continuityVerified: true,
      }),
    /MEASUREMENT/,
  );
  assert.equal(
    store.record(operator, {
      ...input,
      kind: "power",
      loadWatts: 250,
      runtimeMinutes: 480,
      equipment: "UPS",
      continuityVerified: true,
    }).result,
    "recorded-eight-hour-test",
  );
  assert.ok(a.retainUntil >= store.now() + 5 * 365 * DAY);
});
test("independent watchdog detects silence and retries failed dispatch without claiming recipient delivery", async (t) => {
  const { store, advance } = setup(t);
  let sent = 0;
  const dog = new Watchdog(store, {
    notify: async () => {
      sent++;
      if (sent === 1) throw Error("fixture failure");
      return { accepted: true };
    },
  });
  dog.heartbeat("archive-worker", "ok");
  advance(90001);
  let incidents = await dog.tick();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].providerAcceptedAt, null);
  advance(30000);
  incidents = await dog.tick();
  assert.equal(sent, 2);
  assert.ok(incidents[0].providerAcceptedAt - incidents[0].faultAt < 300000);
  assert.equal(incidents[0].recipientReceivedAt, null);
  assert.equal(incidents[0].deliveryWithinFiveMinutes, null);
  advance(300001);
  incidents = await dog.tick();
  assert.equal(incidents[0].deliveryUnconfirmedAfterFiveMinutes, true);
  dog.heartbeat("archive-worker", "ok");
  assert.ok((await dog.tick())[0].resolvedAt);
});
test("audit alteration is detected and missing recorder operations remain explicitly unverified", async (t) => {
  const { store } = setup(t);
  store.db.prepare("UPDATE audit SET event=? WHERE seq=1").run("{}");
  assert.equal(store.auditIntegrity().valid, false);
  const {
      CommercialRecorderSource,
      operations,
    } = require("../../security/server/sources.cjs"),
    source = new CommercialRecorderSource();
  for (const op of operations)
    assert.equal((await source[op]({})).kind, "unverified");
});
test("unknown health cannot postpone an incident with repeated heartbeats", async (t) => {
  const { store, advance } = setup(t);
  let sent = 0;
  const dog = new Watchdog(store, {
    notify: async () => {
      sent++;
      return { accepted: true };
    },
  });
  dog.heartbeat("archive-worker", "unknown");
  const first = (await dog.tick())[0];
  assert.equal(sent, 1);
  advance(30000);
  dog.heartbeat("archive-worker", "unknown");
  assert.equal((await dog.tick())[0].faultAt, first.faultAt);
});
test("durable evidence checks changed user permissions after queueing and renewed leases exclude other workers", async (t) => {
  const { store, advance } = setup(t);
  store.registerUser({ ...operator, name: "Operator" });
  const s = segment(store),
    {
      queueEvidence,
      processEvidence,
    } = require("../../security/server/evidence.cjs");
  const e = queueEvidence(store, operator, {
      cameraId: "one",
      start: s.start,
      end: s.end,
      requestId: "ASYNC",
      purpose: "Deferred export",
    }),
    job = store.claim();
  advance(550000);
  store.renew(job);
  advance(100000);
  assert.equal(store.claim(), null);
  store.registerUser({ ...operator, name: "Operator", role: "technician" });
  await assert.rejects(
    processEvidence(store, { verify: async () => true }, job),
    /ROLE/,
  );
  assert.equal(store.get("exports", e.id).state, "queued");
});
test("reconciliation does not resurrect approved deletion and shared objects block single-segment deletion", async (t) => {
  const { store, advance } = setup(t);
  const id = store.enqueue({ kind: "fixture" }),
    job = store.claim();
  store.finish(job, "complete");
  const s = segment(store, {
    id,
    receipt: {
      objectKey: "same",
      versionId: "v1",
      independent: true,
      immutableStorageVerified: true,
      retainUntil: store.now() + 90 * DAY,
    },
  });
  store.put("deletions", "intent", { segmentId: id, state: "approved" });
  await reconcile(store, { verify: async () => false });
  assert.equal(store.jobs()[0].state, "complete");
  advance(91 * DAY);
  store.put("segments", "second", { ...s, id: "second" });
  assert.ok(
    store
      .deleteEligibility(s)
      .includes("SHARED_ARCHIVE_OBJECT_REQUIRES_GROUP_REVIEW"),
  );
});

test("transfer verifies real synthetic media and resumes derivative work from preserved bytes without refetching", async (t) => {
  const { store, root } = setup(t);
  const source = path.join(root, "synthetic.mp4");
  const made = require("node:child_process").spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=1280x720:r=15",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    source,
  ]);
  assert.equal(made.status, 0);
  const { hashFile } = require("../../lib/security/ring-pilot.cjs"),
    { transfer, buildPlayback } = require("../../security/server/transfer.cjs");
  const sha = await hashFile(source),
    archive = new LocalArchive(path.join(root, "archive"));
  const id = store.enqueue({
    kind: "pilot-import",
    cameraId: "one",
    file: source,
    sha256: sha,
    size: fs.statSync(source).size,
    requestStart: 100000,
    requestEnd: 102000,
    actualStart: 100000,
  });
  let result = await transfer(store, archive, store.claim());
  assert.equal(result.verified, true);
  assert.equal(result.probe.decoded, true);
  assert.equal(result.probe.frameTimelineValid, true);
  assert.equal(result.derivative, null);
  assert.equal(
    store.db.prepare("SELECT state FROM jobs WHERE id=?").get(id).state,
    "complete",
  );
  const build = store.claim();
  assert.equal(build.payload.kind, "playback-build");
  result = await buildPlayback(store, archive, build);
  const originalHash = result.sha256;
  fs.unlinkSync(source);
  fs.unlinkSync(path.join(root, "derivatives", id + ".mp4"));
  store.put("segments", id, { ...result, derivative: null });
  store.db.prepare("UPDATE jobs SET state='queued',next=0 WHERE id=?").run(id);
  result = await transfer(store, archive, store.claim());
  assert.equal(result.sha256, originalHash);
  result = await buildPlayback(store, archive, store.claim());
  assert.equal(result.derivative.video, id + ".mp4");
  assert.equal(store.jobs()[0].state, "complete");
  assert.equal(store.auditIntegrity().valid, true);
});
