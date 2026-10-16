"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Store } = require("../../security/server/store.cjs");
const {
  DiskGuard,
  JOB_HEADROOM,
  capacityError,
} = require("../../security/server/capacity.cjs");
const { preserveMedia } = require("../../lib/security/ring-pilot.cjs");
const { Watchdog } = require("../../security/server/watchdog.cjs");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-capacity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("disk guard pauses on low/unknown space and requires a recovery margin across restart", () => {
  let free = 50e9;
  const options = { statfs: () => ({ bavail: free, bsize: 1 }), env: {} };
  let disk = new DiskGuard("unused", options);
  assert.equal(disk.inspect().state, "ready");
  free = 30e9;
  assert.equal(disk.inspect().state, "warning");
  assert.equal(disk.inspect().paused, false);
  free = 20e9 + JOB_HEADROOM - 1;
  assert.throws(() => disk.assertSpace(JOB_HEADROOM), /DISK_SPACE_LOW/);
  disk = new DiskGuard("unused", { ...options, paused: true });
  free = 24e9;
  assert.equal(disk.inspect().paused, true);
  free = 25e9 + JOB_HEADROOM;
  assert.equal(disk.inspect(JOB_HEADROOM).paused, false);
  free = NaN;
  assert.throws(() => disk.assertSpace(), /DISK_CAPACITY_UNKNOWN/);
  assert.equal(capacityError(Object.assign(Error(), { code: "ENOSPC" })), true);
  for (const value of [
    "0",
    "-1",
    "NaN",
    "1e9",
    "999999999999999999",
    "secret-value",
  ])
    assert.throws(
      () =>
        new DiskGuard("unused", { env: { SECURITY_MIN_FREE_BYTES: value } }),
      /^Error: INVALID_DISK_RESERVE$/,
    );
});
test("a low-space download aborts without publishing a partial original or altering preserved bytes", async (t) => {
  const root = setup(t);
  fs.mkdirSync(path.join(root, "originals"));
  const preserved = path.join(root, "originals", "previous.mp4");
  fs.writeFileSync(preserved, "preserved original");
  let count = 0,
    cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
  const disk = new DiskGuard(root, {
    env: {},
    statfs: () => ({ bsize: 1, bavail: ++count === 1 ? 50e9 : 1e9 }),
  });
  await assert.rejects(
    preserveMedia(response, root, "job", 10000, (bytes) =>
      disk.assertSpace(bytes),
    ),
    /DISK_SPACE_LOW/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(path.join(root, "originals")), [
    "previous.mp4",
  ]);
  assert.equal(fs.readFileSync(preserved, "utf8"), "preserved original");
});
test("capacity deferrals preserve identity and prior retry counts, reject stale owners and recover", (t) => {
  const root = setup(t);
  let now = 100000;
  const store = new Store(root, { now: () => now });
  t.after(() => store.close());
  const id = store.enqueue({ kind: "pilot-import", cameraId: "one" });
  store.db.prepare("UPDATE jobs SET attempts=4 WHERE id=?").run(id);
  const job = store.claim();
  assert.equal(job.attempts, 5);
  store.deferForCapacity(job, "DISK_SPACE_LOW");
  assert.equal(store.jobs()[0].attempts, 4);
  assert.equal(store.claim(), null);
  assert.throws(
    () => store.deferForCapacity(job, "DISK_SPACE_LOW"),
    /LEASE_LOST/,
  );
  now += 30001;
  const next = store.claim();
  assert.equal(next.id, id);
  assert.equal(next.attempts, 5);
  assert.throws(() => store.finish(job, "complete"), /LEASE_LOST/);
  store.finish(next, "complete");
});
test("worker restart leaves jobs untouched under pressure and resumes the same synthetic job after recovery", (t) => {
  const root = setup(t),
    source = path.join(root, "source.mp4");
  const made = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x240:r=15",
    "-t",
    "2",
    "-c:v",
    "libx264",
    source,
  ]);
  assert.equal(made.status, 0);
  const sha = require("node:crypto")
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
  const store = new Store(root);
  t.after(() => store.close());
  store.put("cameras", "one", {
    id: "one",
    source: "ring",
    exportEnabled: false,
  });
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
  const run = (reserve) =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
      {
        env: {
          PATH: process.env.PATH,
          SECURITY_DATA_DIR: root,
          SECURITY_MIN_FREE_BYTES: reserve,
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
  assert.equal(run("1000000000000000").status, 0);
  assert.equal(store.jobs()[0].attempts, 0);
  assert.equal(store.jobs()[0].state, "queued");
  assert.equal(store.get("segments", id), null);
  const h = store.get("heartbeats", "archive-worker");
  assert.equal(h.disk.paused, true);
  assert.equal(h.status, "failed");
  assert.equal(run("1000000000000000").status, 0);
  assert.equal(store.jobs()[0].attempts, 0);
  assert.equal(run("1000000000").status, 0);
  assert.equal(store.jobs()[0].state, "complete");
  assert.equal(store.get("segments", id).sha256, sha);
  assert.equal(store.get("heartbeats", "archive-worker").disk.paused, false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(store.auditIntegrity().valid, true);
});
test("playback encoding stops on capacity loss and removes only its unfinished derivative", async (t) => {
  const root = setup(t),
    bin = path.join(root, "bin"),
    source = path.join(root, "original.mp4");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "derivatives"));
  fs.writeFileSync(source, "unchanged original fixture");
  // A controlled encoder fixture writes slowly so the real process monitor fires.
  fs.writeFileSync(
    path.join(bin, "ffmpeg"),
    `#!${process.execPath}\nconst fs = require('node:fs'); const target = process.argv.at(-1); setInterval(() => fs.appendFileSync(target, Buffer.alloc(128)), 50);\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  let reads = 0;
  const disk = new DiskGuard(root, {
    env: {},
    statfs: () => ({ bsize: 1, bavail: ++reads === 1 ? 50e9 : 1e9 }),
  });
  try {
    const { derive } = require("../../security/server/transfer.cjs");
    await assert.rejects(
      derive({ root }, source, "fixture", disk),
      /DISK_SPACE_LOW/,
    );
    assert.deepEqual(fs.readdirSync(path.join(root, "derivatives")), []);
    assert.equal(fs.readFileSync(source, "utf8"), "unchanged original fixture");
  } finally {
    process.env.PATH = originalPath;
  }
});
test("disk fault heartbeat reaches the watchdog incident/retry path without claiming delivery", async (t) => {
  const root = setup(t),
    store = new Store(root);
  t.after(() => store.close());
  let sends = 0;
  const dog = new Watchdog(store, {
    notify: async () => {
      sends++;
      return { accepted: true };
    },
  });
  dog.heartbeat("archive-worker", "failed");
  const incidents = await dog.tick();
  assert.equal(sends, 1);
  assert.ok(incidents[0].providerAcceptedAt);
  assert.equal(incidents[0].recipientReceivedAt, null);
  assert.equal(incidents[0].deliveryWithinFiveMinutes, null);
});
test("local preservation stops on capacity loss without replacing existing original bytes", async (t) => {
  const root = setup(t),
    file = path.join(root, "source.mp4");
  const { LocalArchive } = require("../../security/server/archive.cjs");
  const { hashFile } = require("../../lib/security/ring-pilot.cjs");
  fs.writeFileSync(file, Buffer.alloc(150000, 7));
  const archive = new LocalArchive(path.join(root, "archive")),
    sha = await hashFile(file);
  const receipt = await archive.put(file, sha, 150000, Date.now());
  let writes = 0;
  const disk = new DiskGuard(root, {
    env: {},
    statfs: () => ({ bsize: 1, bavail: ++writes === 1 ? 50e9 : 1e9 }),
  });
  await assert.rejects(
    archive.put(file, sha, 150000, Date.now(), {
      beforeWrite: (bytes) => disk.assertSpace(bytes),
    }),
    /DISK_SPACE_LOW/,
  );
  assert.equal(await archive.verify(receipt), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(archive.file(receipt.objectKey))),
    [sha + ".mp4"],
  );
});
