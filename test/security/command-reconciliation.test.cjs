"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { Store, DAY, digest } = require("../../security/server/store.cjs");
const {
  LocalArchive,
  inspectBytes,
} = require("../../security/server/archive.cjs");
const {
  options,
  scheduleVerification,
  inspectSegment,
  processVerification,
  observeVerification,
} = require("../../security/server/reconciliation.cjs");
const { Watchdog } = require("../../security/server/watchdog.cjs");
const config = options();
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-reconcile-"));
  let now = Date.now();
  const store = new Store(root, { now: () => now }),
    archive = new LocalArchive(path.join(root, "archive"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, "original.mp4"),
    bytes = Buffer.from("synthetic preserved original");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const sha = digest(bytes),
    receipt = await archive.put(file, sha, bytes.length, now + 90 * DAY);
  receipt.readbackVerifiedAt = now - 8 * DAY;
  store.put("cameras", "one", {
    id: "one",
    name: "Test",
    source: "ring",
    exportEnabled: false,
    room: "TEST",
    location: "Fixture",
  });
  const id = store.enqueue({
    kind: "pilot-import",
    cameraId: "one",
    file,
    sha256: sha,
    size: bytes.length,
  });
  const j = store.claim();
  store.finish(j, "complete");
  const s = {
    id,
    cameraId: "one",
    source: "ring",
    start: now - 8 * DAY,
    end: now - 8 * DAY + 1000,
    requested: { start: now - 8 * DAY, end: now - 8 * DAY + 1000 },
    ingestedAt: now - 8 * DAY,
    verified: true,
    sha256: sha,
    bytes: bytes.length,
    receipt,
    derivative: null,
  };
  store.put("segments", id, s);
  const actor = { id: "owner", role: "owner", mfa: true, cameraIds: ["*"] };
  return {
    root,
    store,
    archive,
    file,
    bytes,
    id,
    s,
    actor,
    now: () => now,
    advance: (n) => (now += n),
  };
}
test("readback classifies complete, missing, altered, oversized, unavailable and timed-out bodies without leaking provider errors", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.archive.inspect(f.s.receipt)).state, "verified");
  fs.writeFileSync(f.archive.file(f.s.receipt.objectKey), "altered");
  assert.equal((await f.archive.inspect(f.s.receipt)).state, "mismatch");
  fs.unlinkSync(f.archive.file(f.s.receipt.objectKey));
  assert.equal((await f.archive.inspect(f.s.receipt)).state, "missing");
  let oversizedDestroyed = false;
  const oversized = new Readable({
    read() {
      this.push(Buffer.alloc(f.bytes.length + 1));
    },
    destroy(e, cb) {
      oversizedDestroyed = true;
      cb(e);
    },
  });
  assert.equal(
    (await inspectBytes(async () => oversized, f.s.receipt)).code,
    "ARCHIVE_SIZE_MISMATCH",
  );
  assert.equal(oversizedDestroyed, true);
  const unavailable = await inspectBytes(async () => {
    throw Error("SECRET_PROVIDER_DETAIL");
  }, f.s.receipt);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(JSON.stringify(unavailable).includes("SECRET"), false);
  const stalled = new Readable({ read() {} });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await inspectBytes(async () => stalled, f.s.receipt, {
      timeoutMs: 20,
    });
    assert.equal(result.code, "ARCHIVE_READBACK_TIMEOUT");
    assert.equal(stalled.destroyed, true);
  } finally {
    clearTimeout(keepAlive);
  }
});
test("verification jobs are bounded, deduplicated and due again on a durable cadence across restart", async (t) => {
  const f = await fixture(t);
  assert.equal(config.intervalMs, 7 * DAY);
  for (const value of ["0", "-1", "1.5", "721", "secret"])
    assert.throws(
      () => options({ SECURITY_ARCHIVE_VERIFY_HOURS: value }),
      /INVALID_ARCHIVE_VERIFY_INTERVAL/,
    );
  assert.equal(scheduleVerification(f.store), 1);
  assert.equal(scheduleVerification(f.store), 0);
  const first = f.store.claim();
  assert.equal(first.payload.kind, "archive-verify");
  await processVerification(f.store, f.archive, first);
  assert.equal(scheduleVerification(f.store), 0);
  const reopened = new Store(f.root, { now: f.now });
  try {
    f.advance(7 * DAY);
    assert.equal(scheduleVerification(reopened), 1);
    const next = reopened.claim();
    assert.equal(next.id, first.id);
    await processVerification(reopened, f.archive, next);
    assert.equal(reopened.get("archive-checks", f.id).checks, 2);
    assert.equal(
      reopened.get("segments", f.id).receipt.readbackVerifiedAt,
      f.now(),
    );
  } finally {
    reopened.close();
  }
  for (let i = 0; i < 25; i++)
    f.store.put("segments", digest("extra-" + i), {
      ...f.s,
      id: digest("extra-" + i),
    });
  assert.equal(scheduleVerification(f.store, { ...config, batch: 3 }), 3);
});
test("failed readback revokes coverage without re-exporting originals and exact-byte recovery restores it", async (t) => {
  const f = await fixture(t);
  const before = f.store.timeline(f.actor, "one", f.s.start, f.s.end);
  assert.equal(before.coveredMs, 1000);
  fs.writeFileSync(f.archive.file(f.s.receipt.objectKey), "changed bytes");
  scheduleVerification(f.store);
  const j = f.store.claim();
  await assert.rejects(
    processVerification(f.store, f.archive, j),
    /ARCHIVE_.*MISMATCH/,
  );
  f.store.finish(j, "failed", "ARCHIVE_READBACK_MISMATCH", f.now());
  assert.equal(f.store.get("segments", f.id).verified, false);
  assert.equal(
    f.store.timeline(f.actor, "one", f.s.start, f.s.end).coveredMs,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT state,attempts FROM jobs WHERE id=?").get(f.id)
      .state,
    "complete",
  );
  const health = observeVerification(f.store);
  assert.ok(health.faultCodes.includes("ARCHIVE_READBACK_FAILED"));
  assert.equal(health.rows[0].mismatch, 1);
  assert.equal(
    f.store.cameraStatus(f.actor, f.store.get("cameras", "one")).archive.state,
    "failed",
  );
  fs.writeFileSync(f.archive.file(f.s.receipt.objectKey), f.bytes);
  f.advance(3600000);
  assert.equal(scheduleVerification(f.store), 1);
  await processVerification(f.store, f.archive, f.store.claim());
  assert.equal(
    f.store.timeline(f.actor, "one", f.s.start, f.s.end).coveredMs,
    1000,
  );
  assert.equal(observeVerification(f.store).rows[0].failed, 0);
  assert.equal(f.store.auditIntegrity().valid, true);
});
test("temporary read failure remains an unavailability finding, retries unchanged version and does not claim footage loss", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const archive = {
    inspect: async (r) => {
      reads++;
      assert.equal(r.versionId, f.s.receipt.versionId);
      return { state: "unavailable", code: "ARCHIVE_READBACK_UNAVAILABLE" };
    },
  };
  const result = await inspectSegment(f.store, archive, f.id);
  assert.equal(result.state, "unavailable");
  assert.equal(result.lastVerifiedAt, f.s.receipt.readbackVerifiedAt);
  assert.equal(f.store.jobs().length, 1);
  assert.equal(scheduleVerification(f.store), 0);
  f.advance(3600000);
  scheduleVerification(f.store);
  await assert.rejects(
    processVerification(f.store, archive, f.store.claim()),
    /ARCHIVE_READBACK_UNAVAILABLE/,
  );
  assert.equal(reads, 2);
  const health = observeVerification(f.store);
  assert.equal(health.rows[0].missing, 0);
  assert.equal(health.rows[0].unavailable, 1);
});
test("deletion or receipt replacement during readback cannot resurrect or overwrite current evidence state", async (t) => {
  for (const change of ["deleted", "approved", "receipt"]) {
    const f = await fixture(t);
    scheduleVerification(f.store);
    const job = f.store.claim();
    const archive = {
      inspect: async () => {
        if (change === "deleted")
          f.store.put("segments", f.id, {
            ...f.s,
            deletedAt: f.now(),
            verified: false,
          });
        if (change === "approved")
          f.store.put("deletions", "intent", {
            segmentId: f.id,
            state: "approved",
          });
        if (change === "receipt")
          f.store.put("segments", f.id, {
            ...f.s,
            receipt: { ...f.s.receipt, versionId: "new-version" },
          });
        return { state: "verified" };
      },
    };
    if (change === "receipt")
      await assert.rejects(
        processVerification(f.store, archive, job),
        /ARCHIVE_RECEIPT_CHANGED/,
      );
    else
      assert.equal(
        (await processVerification(f.store, archive, job)).state,
        "skipped",
      );
    assert.equal(f.store.get("archive-checks", f.id), null);
    if (change === "deleted")
      assert.equal(f.store.get("segments", f.id).verified, false);
  }
});
test("expired verification leases recover without duplicate admission and stale workers cannot publish", async (t) => {
  const f = await fixture(t);
  scheduleVerification(f.store);
  const old = f.store.claim();
  f.advance(600001);
  const restarted = new Store(f.root, { now: f.now });
  try {
    assert.equal(scheduleVerification(restarted), 0);
    const current = restarted.claim();
    assert.equal(current.id, old.id);
    await assert.rejects(
      processVerification(f.store, f.archive, old),
      /LEASE_LOST/,
    );
    assert.equal(f.store.get("archive-checks", f.id), null);
    await processVerification(restarted, f.archive, current);
    assert.equal(restarted.get("archive-checks", f.id).checks, 1);
  } finally {
    restarted.close();
  }
});
test("verification remains behind new originals but can run when disk pressure prevents media-writing work", async (t) => {
  const f = await fixture(t);
  scheduleVerification(f.store);
  const original = f.store.enqueue({
    kind: "ring-export",
    cameraId: "one",
    requestStart: f.now() - 3600000,
    requestEnd: f.now() - 3300000,
  });
  const first = f.store.claim();
  assert.equal(first.id, original);
  f.store.finish(first, "queued", null, 0);
  const check = f.store.claim({ verificationOnly: true });
  assert.equal(check.payload.kind, "archive-verify");
  await processVerification(f.store, f.archive, check);
  assert.equal(f.store.claim({ verificationOnly: true }), null);
  assert.equal(f.store.claim().id, original);
});
test("overdue checks and detected corruption reach the independent watchdog fault path", async (t) => {
  const f = await fixture(t);
  f.advance(2 * DAY);
  let health = observeVerification(f.store);
  assert.ok(health.faultCodes.includes("ARCHIVE_VERIFICATION_OVERDUE"));
  fs.unlinkSync(f.archive.file(f.s.receipt.objectKey));
  await inspectSegment(f.store, f.archive, f.id);
  health = observeVerification(f.store);
  const notifications = [];
  const watchdog = new Watchdog(f.store, {
    notify: async (x) => {
      notifications.push(x);
      return { accepted: true };
    },
  });
  watchdog.heartbeat("archive-worker", "failed", health.faultCodes);
  await watchdog.tick();
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].faultCodes.includes("ARCHIVE_READBACK_FAILED"));
  assert.equal(
    f.store.get("incidents", "archive-worker").deliveryWithinFiveMinutes,
    null,
  );
});
test("a real worker rechecks a missing archive under simulated disk pressure without restarting the original transfer", async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(f.archive.file(f.s.receipt.objectKey));
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: process.env.PATH,
        SECURITY_DATA_DIR: f.root,
        SECURITY_MIN_FREE_BYTES: "1000000000000000",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(f.store.get("archive-checks", f.id).state, "missing");
  assert.equal(f.store.get("heartbeats", "archive-worker").disk.paused, true);
  assert.ok(
    f.store
      .get("heartbeats", "archive-worker")
      .faultCodes.includes("ARCHIVE_READBACK_FAILED"),
  );
  assert.equal(
    f.store.db.prepare("SELECT state,attempts FROM jobs WHERE id=?").get(f.id)
      .state,
    "complete",
  );
  assert.equal(fs.readFileSync(f.file).equals(f.bytes), true);
});
