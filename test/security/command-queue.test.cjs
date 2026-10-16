"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { Store, DAY, digest } = require("../../security/server/store.cjs");
const { priority } = require("../../security/server/queue-priority.cjs");
const {
  transfer,
  buildPlayback,
} = require("../../security/server/transfer.cjs");
const { LocalArchive } = require("../../security/server/archive.cjs");
const { assessPipelines } = require("../../security/server/pipeline.cjs");
const { hashFile } = require("../../lib/security/ring-pilot.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-priority-"));
  let now = Date.now();
  const store = new Store(root, { now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, now: () => now, advance: (ms) => (now += ms) };
}
function camera(f, id, days) {
  const c = {
    id,
    source: "ring",
    exportEnabled: true,
    enabledAt: f.now() - 20 * DAY,
    continuousHistoryDays: days,
    continuousHistoryEvidence: days ? "synthetic setting" : null,
  };
  f.store.put("cameras", id, c);
  return c;
}
function ringJob(f, cameraId, age, extra = {}) {
  return f.store.enqueue({
    kind: "ring-export",
    cameraId,
    requestStart: f.now() - age,
    requestEnd: f.now() - age + 1000,
    ...extra,
  });
}
function complete(f) {
  const j = f.store.claim();
  assert.ok(j);
  f.store.finish(j, "complete");
  return j.id;
}
async function video(f) {
  const file = path.join(f.root, "fixture.mp4");
  const made = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=15:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  assert.equal(made.status, 0);
  const sha256 = await hashFile(file),
    size = fs.statSync(file).size;
  const id = f.store.enqueue({
    kind: "pilot-import",
    cameraId: "one",
    file,
    sha256,
    size,
    requestStart: f.now() - 10000,
    requestEnd: f.now() - 9000,
    actualStart: f.now() - 10000,
  });
  return { file, sha256, size, id };
}
test("missing originals precede user and background playback, ordered across cameras by estimated source boundary", (t) => {
  const f = fixture(t);
  camera(f, "long", 14);
  camera(f, "short", 1);
  camera(f, "unknown");
  const background = f.store.enqueue({
    kind: "playback-build",
    segmentId: digest("old background"),
  });
  const requested = f.store.enqueue({
    kind: "playback-restore",
    segmentId: digest("requested"),
  });
  const beyond = ringJob(f, "short", 3 * DAY);
  const later = ringJob(f, "long", 13 * DAY);
  const earliest = ringJob(f, "short", DAY - 3600000);
  const unknown = ringJob(f, "unknown", 14 * DAY - 7200000);
  assert.equal(complete(f), earliest);
  assert.equal(complete(f), unknown);
  assert.equal(complete(f), later);
  assert.equal(complete(f), beyond);
  assert.equal(complete(f), requested);
  assert.equal(complete(f), background);
  const dispatch = f.store.get("job-dispatch", unknown);
  assert.equal(dispatch.historyBasis, "advertised-maximum-only");
  assert.equal(dispatch.availabilityGuaranteed, false);
  assert.equal(
    f.store.get("job-dispatch", beyond).reason,
    "original-beyond-estimated-source-window",
  );
});
test("queue ordering respects retry deadlines, leases, same-segment serialization and original job identity", (t) => {
  const f = fixture(t);
  camera(f, "one", 14);
  const delayed = ringJob(f, "one", 13 * DAY),
    ready = ringJob(f, "one", 12 * DAY);
  const originalPayload = f.store.db
    .prepare("SELECT payload FROM jobs WHERE id=?")
    .get(delayed).payload;
  f.store.db
    .prepare("UPDATE jobs SET next=? WHERE id=?")
    .run(f.now() + 30000, delayed);
  const first = f.store.claim();
  assert.equal(first.id, ready);
  const playback = f.store.enqueue({
    kind: "playback-build",
    segmentId: ready,
  });
  assert.equal(f.store.claim(), null);
  f.advance(30000);
  assert.equal(complete(f), delayed);
  assert.equal(
    f.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(delayed)
      .payload,
    originalPayload,
  );
  const reopened = new Store(f.root, { now: f.now });
  try {
    assert.equal(reopened.claim(), null);
    f.advance(600001);
    const retry = reopened.claim();
    assert.equal(retry.id, ready);
    assert.notEqual(retry.owner, first.owner);
    assert.throws(() => f.store.finish(first, "complete"), /LEASE_LOST/);
    reopened.finish(retry, "complete");
    assert.equal(reopened.claim().id, playback);
  } finally {
    reopened.close();
  }
});
test("a verified preserved original removes source urgency while stale or incomplete receipts cannot do so", (t) => {
  const f = fixture(t),
    c = camera(f, "one", 14),
    p = {
      kind: "ring-export",
      cameraId: c.id,
      requestStart: f.now() - 13 * DAY,
    };
  const s = {
    verified: true,
    sha256: "a".repeat(64),
    bytes: 10,
    receipt: { sha256: "a".repeat(64), size: 10, readbackVerifiedAt: f.now() },
  };
  assert.equal(priority(p, s, c, f.now()).reason, "requested-support-work");
  for (const patch of [
    { verified: false },
    { deletedAt: f.now() },
    { receipt: { ...s.receipt, readbackVerifiedAt: f.now() + 1 } },
    { receipt: { ...s.receipt, sha256: "b".repeat(64) } },
    { receipt: null },
  ])
    assert.equal(
      priority(p, { ...s, ...patch }, c, f.now()).reason,
      "original-within-estimated-source-window",
    );
});
test("priority selection searches the full durable backlog and recomputes changed storage estimates", (t) => {
  const f = fixture(t);
  camera(f, "one", 14);
  camera(f, "two", 14);
  f.store.tx(() => {
    for (let i = 0; i < 5000; i++)
      f.store.enqueue({
        kind: "playback-build",
        segmentId: digest("background-" + i),
      });
  });
  const first = ringJob(f, "one", 2 * DAY),
    second = ringJob(f, "two", 3 * DAY);
  camera(f, "one", 3); // Its estimated deadline is now nearer, without retimestamping jobs.
  const before = process.hrtime.bigint();
  assert.equal(complete(f), first);
  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  assert.equal(
    f.store.get("job-dispatch", first).estimatedSourceBoundaryAt,
    f.now() + DAY,
  );
  assert.equal(complete(f), second);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM jobs WHERE state='queued'")
      .get().n,
    5000,
  );
  t.diagnostic(
    `Selection over 5,002 queued jobs took ${elapsedMs.toFixed(1)} ms on this development host; not a sustained Mini benchmark.`,
  );
});
test("original receipt, durable playback job and transfer completion commit together", async (t) => {
  const f = fixture(t);
  camera(f, "one", 14);
  const v = await video(f),
    archive = new LocalArchive(path.join(f.root, "archive"));
  const original = f.store.claim(),
    enqueue = f.store.enqueue.bind(f.store);
  f.store.enqueue = (p) => {
    if (p.kind === "playback-build") throw Error("SIMULATED_QUEUE_FAILURE");
    return enqueue(p);
  };
  await assert.rejects(
    transfer(f.store, archive, original),
    /SIMULATED_QUEUE_FAILURE/,
  );
  assert.equal(f.store.get("segments", v.id), null);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(v.id).state,
    "running",
  );
  f.store.enqueue = enqueue;
  const s = await transfer(f.store, archive, original);
  assert.equal(s.derivative, null);
  assert.equal(await archive.verify(s.receipt), true);
  const build = f.store.claim();
  assert.equal(build.payload.kind, "playback-build");
  assert.equal(build.payload.segmentId, v.id);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(v.id).state,
    "complete",
  );
  fs.unlinkSync(v.file);
  const result = await buildPlayback(f.store, archive, build);
  assert.equal(result.sha256, v.sha256);
  assert.equal(
    await hashFile(path.join(f.root, "derivatives", result.derivative.video)),
    result.derivative.sha256,
  );
  assert.equal(f.store.auditIntegrity().valid, true);
});
test("playback failures remain separate from verified original coverage and source risk", async (t) => {
  const f = fixture(t);
  const c = camera(f, "one", 14);
  f.store.put("cameras", "one", { ...c, enabledAt: f.now() - 600000 });
  const v = await video(f),
    archive = new LocalArchive(path.join(f.root, "archive"));
  const s = await transfer(f.store, archive, f.store.claim());
  f.advance(1000);
  const ready = assessPipelines(f.store)[0].readyThrough;
  f.store.put("segments", s.id, {
    ...s,
    start: f.store.get("cameras", "one").enabledAt,
    end: ready,
  });
  const j = f.store.claim();
  f.store.finish(j, "failed", "DERIVATIVE_FAILED");
  const row = assessPipelines(f.store)[0];
  assert.equal(row.originals.missingMs, 0);
  assert.equal(row.sourceWindowRemainingMs, null);
  assert.equal(row.jobs.originalPending, 0);
  assert.equal(row.jobs.playbackPending, 1);
  assert.ok(row.faultCodes.includes("PLAYBACK_BACKLOG"));
  assert.ok(!row.faultCodes.includes("TRANSFER_FAILED"));
  assert.equal(await archive.verify(s.receipt), true);
  assert.equal(v.sha256, s.sha256);
});
test("background playback reuses hash-verified managed staging and falls back to the archive for altered bytes", async (t) => {
  for (const damaged of [false, true]) {
    const f = fixture(t);
    camera(f, "one", 14);
    const v = await video(f),
      archive = new LocalArchive(path.join(f.root, "archive"));
    const s = await transfer(f.store, archive, f.store.claim());
    const staged = path.join(
      f.root,
      "staging",
      "originals",
      `${s.id}.${s.sha256}.mp4`,
    );
    fs.copyFileSync(v.file, staged);
    fs.chmodSync(staged, 0o600);
    if (damaged) fs.writeFileSync(staged, "altered local copy");
    let reads = 0;
    const read = archive.read.bind(archive);
    archive.read = async (r) => {
      reads++;
      return read(r);
    };
    const result = await buildPlayback(f.store, archive, f.store.claim());
    assert.equal(reads, damaged ? 1 : 0);
    assert.ok(f.store.playbackReady(result));
    assert.equal(await archive.verify(s.receipt), true);
    if (damaged)
      assert.equal(
        fs.readFileSync(staged, "utf8"),
        "altered local copy",
        "unknown bytes remain preserved for review",
      );
  }
});
test("disabling a camera blocks already queued Ring requests before any provider call", async (t) => {
  const f = fixture(t);
  const c = camera(f, "one", 14);
  f.store.put("cameras", "one", { ...c, exportEnabled: false });
  f.store.put("policy", "ring", {
    automatedExportsApproved: true,
    decisionReference: "synthetic fixture",
  });
  ringJob(f, "one", 3600000);
  let called = false;
  await assert.rejects(
    transfer(
      f.store,
      new LocalArchive(path.join(f.root, "archive")),
      f.store.claim(),
      {
        ring: {
          pilotRequest: async () => {
            called = true;
            throw Error();
          },
        },
      },
    ),
    /CAMERA_EXPORTS_DISABLED/,
  );
  assert.equal(called, false);
});
test("a real worker reports an encoding failure separately while leaving the original transfer complete", async (t) => {
  const f = fixture(t);
  const c = camera(f, "one", 14);
  f.store.put("cameras", "one", { ...c, exportEnabled: false });
  const v = await video(f),
    bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  const realFfmpeg = spawnSync("which", ["ffmpeg"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(path.isAbsolute(realFfmpeg));
  fs.writeFileSync(
    path.join(bin, "ffmpeg"),
    `#!${process.execPath}\nif(process.argv.includes('scale=-2:720'))process.exit(1);const r=require('node:child_process').spawnSync(${JSON.stringify(realFfmpeg)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);`,
    { mode: 0o700 },
  );
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        SECURITY_DATA_DIR: f.root,
        SECURITY_MIN_FREE_BYTES: "1000000000",
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(v.id).state,
    "complete",
  );
  assert.equal(f.store.get("segments", v.id).verified, true);
  const h = f.store.get("heartbeats", "archive-worker");
  assert.ok(h.faultCodes.includes("PLAYBACK_BACKLOG"));
  assert.ok(!h.faultCodes.includes("TRANSFER_FAILED"));
});
test("actual worker kill during encoding preserves the completed original and restart rebuilds without the import source", async (t) => {
  const f = fixture(t);
  camera(f, "one", 14);
  f.store.put("policy", "ring", { automatedExportsApproved: false });
  const v = await video(f),
    bin = path.join(f.root, "bin"),
    marker = path.join(f.root, "encoding-started");
  fs.mkdirSync(bin);
  const realFfmpeg = spawnSync("which", ["ffmpeg"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(path.isAbsolute(realFfmpeg));
  fs.writeFileSync(
    path.join(bin, "ffmpeg"),
    `#!${process.execPath}\nif(process.argv.includes('scale=-2:720')){require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);}else{const r=require('node:child_process').spawnSync(${JSON.stringify(realFfmpeg)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}`,
    { mode: 0o700 },
  );
  const script = path.resolve(__dirname, "../../security/worker.cjs");
  const child = spawn(process.execPath, [script, "--once"], {
    env: {
      PATH: bin + path.delimiter + process.env.PATH,
      SECURITY_DATA_DIR: f.root,
      SECURITY_MIN_FREE_BYTES: "1000000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.resume();
  let encoder;
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (encoder)
      try {
        process.kill(encoder, "SIGKILL");
      } catch {}
  });
  const exited = once(child, "exit");
  const deadline = Date.now() + 10000;
  while (
    !fs.existsSync(marker) &&
    Date.now() < deadline &&
    child.exitCode === null
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    fs.existsSync(marker),
    "controlled encoder must start after original is durable",
  );
  // The child encoder survives its parent's SIGKILL on macOS; record and stop only it.
  encoder = Number(fs.readFileSync(marker, "utf8"));
  assert.ok(Number.isSafeInteger(encoder) && encoder > 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(v.id).state,
    "complete",
  );
  const s = f.store.get("segments", v.id);
  assert.equal(s.sha256, v.sha256);
  assert.equal(s.derivative, null);
  child.kill("SIGKILL");
  await exited;
  process.kill(encoder, "SIGKILL");
  encoder = null;
  fs.unlinkSync(v.file);
  // Advance the persisted lease to model the ten-minute reclaim boundary without waiting.
  f.store.db.prepare("UPDATE jobs SET lease=0 WHERE state='running'").run();
  const restarted = spawnSync(process.execPath, [script, "--once"], {
    env: {
      PATH: process.env.PATH,
      SECURITY_DATA_DIR: f.root,
      SECURITY_MIN_FREE_BYTES: "1000000000",
    },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok(f.store.playbackReady(f.store.get("segments", v.id)));
  assert.equal(
    f.store.db.prepare("SELECT attempts FROM jobs WHERE id=?").get(v.id)
      .attempts,
    1,
  );
  assert.equal(f.store.get("segments", v.id).sha256, v.sha256);
  assert.equal(f.store.auditIntegrity().valid, true);
});
