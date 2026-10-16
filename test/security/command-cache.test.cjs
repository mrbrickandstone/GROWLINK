"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { Store, DAY, digest } = require("../../security/server/store.cjs");
const { LocalArchive } = require("../../security/server/archive.cjs");
const {
  options,
  evict,
  maintainCache,
  reconcileCacheState,
} = require("../../security/server/cache.cjs");
const {
  queuePlayback,
  playbackStatus,
  processPlayback,
} = require("../../security/server/playback.cjs");
const {
  derive,
  restoreDerivative,
  prepareDirectories,
} = require("../../security/server/transfer.cjs");
const { hashFile } = require("../../lib/security/ring-pilot.cjs");
const config = { enabled: true, keepMs: DAY };
async function fixture(t, { video = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-cache-"));
  let now = Date.now();
  const store = new Store(root, { now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  prepareDirectories(store);
  const file = path.join(root, "import.mp4");
  if (video) {
    const result = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=320x180:r=15:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    assert.equal(
      result.status,
      0,
      "FFmpeg synthetic fixture must be available",
    );
  } else fs.writeFileSync(file, "original fixture", { mode: 0o600 });
  const sha = await hashFile(file),
    bytes = fs.statSync(file).size;
  const local = new LocalArchive(path.join(root, "fixture-remote"));
  const receipt = {
    ...(await local.put(file, sha, bytes, now + 90 * DAY)),
    independent: true,
    immutableStorageVerified: true,
  };
  let verifies = 0;
  // Fixture only: this directory is NOT a qualified independent archive.
  const archive = {
    independent: true,
    lockApproved: true,
    read: (r) => local.read(r),
    verify: async (r) => {
      verifies++;
      return local.verify(r);
    },
    verifyProtection: async (r, until) =>
      r.versionId === receipt.versionId && r.retainUntil >= until,
  };
  const id = digest("cache-segment");
  const cached = path.join(root, "staging", "originals", `${id}.${sha}.mp4`);
  fs.copyFileSync(file, cached);
  fs.chmodSync(cached, 0o600);
  const derivative = video
    ? await derive(store, file, id)
    : { video: id + ".mp4", image: id + ".jpg" };
  const playback = path.join(root, "derivatives", derivative.video);
  if (!video) {
    fs.writeFileSync(playback, "playback fixture", { mode: 0o600 });
    fs.writeFileSync(
      path.join(root, "derivatives", derivative.image),
      "thumb",
      { mode: 0o600 },
    );
  }
  derivative.sha256 = await hashFile(playback);
  const s = {
    id,
    cameraId: "one",
    source: "recorder",
    start: now - 3 * DAY,
    end: now - 3 * DAY + 1000,
    requested: { start: now - 3 * DAY, end: now - 3 * DAY + 1000 },
    ingestedAt: now - 2 * DAY,
    verified: true,
    sha256: sha,
    bytes,
    receipt,
    derivative,
  };
  store.put("segments", id, s);
  store.put("cameras", "one", { id: "one", source: "recorder" });
  const owner = {
    id: "owner",
    name: "Fixture owner",
    role: "owner",
    cameraIds: ["one"],
    mfa: true,
    externalAuthenticated: true,
  };
  store.registerUser(owner);
  return {
    store,
    archive,
    local,
    root,
    id,
    cached,
    playback,
    file,
    s,
    owner,
    verifies: () => verifies,
    advance: (ms) => (now += ms),
  };
}
test("cache cleanup defaults off and cannot evict local-only, held, recent, or policy-blocked footage", async (t) => {
  const f = await fixture(t);
  assert.equal(options({}).enabled, false);
  assert.equal(options({}).keepMs, DAY);
  for (const hours of ["0", "-1", "0.5", "721", "NaN"])
    assert.throws(
      () => options({ SECURITY_CACHE_KEEP_HOURS: hours }),
      /INVALID_CACHE_AGE/,
    );
  assert.equal((await evict(f.store, f.archive, f.id)).removed, 0);
  assert.equal((await evict(f.store, f.local, f.id, config)).removed, 0);
  f.store.put("holds", "hold", {
    id: "hold",
    cameraId: "one",
    start: f.s.start,
    end: f.s.end,
    state: "pending",
  });
  assert.equal((await evict(f.store, f.archive, f.id, config)).removed, 0);
  f.store.put("holds", "hold", {
    ...f.store.get("holds", "hold"),
    state: "released",
  });
  f.store.put("segments", f.id, {
    ...f.s,
    cache: { materializedAt: f.store.now() },
  });
  assert.equal((await evict(f.store, f.archive, f.id, config)).removed, 0);
  f.store.put("segments", f.id, { ...f.s, source: "ring" });
  assert.equal((await evict(f.store, f.archive, f.id, config)).removed, 0);
  assert.equal(f.verifies(), 0);
  assert.ok(fs.existsSync(f.cached));
  assert.ok(fs.existsSync(f.playback));
});
test("cache eviction fresh-verifies protected originals and leaves imports, thumbnails, alternate bytes and coverage intact", async (t) => {
  const f = await fixture(t);
  const alternate = path.join(
    f.root,
    "staging",
    "originals",
    `${f.id}.${"f".repeat(64)}.mp4`,
  );
  fs.writeFileSync(alternate, "different response bytes");
  const before = f.store.timeline(f.owner, "one", f.s.start, f.s.end);
  const result = await evict(f.store, f.archive, f.id, config);
  assert.equal(result.removed, 2);
  assert.equal(f.verifies(), 1);
  assert.equal(fs.existsSync(f.cached), false);
  assert.equal(fs.existsSync(f.playback), false);
  assert.ok(fs.existsSync(f.file));
  assert.ok(fs.existsSync(alternate));
  assert.ok(fs.existsSync(path.join(f.root, "derivatives", f.id + ".jpg")));
  assert.equal(await f.local.verify(f.s.receipt), true);
  const after = f.store.timeline(f.owner, "one", f.s.start, f.s.end);
  assert.equal(after.coveredMs, before.coveredMs);
  assert.equal(after.segments[0].derivativeReady, false);
  assert.equal(f.store.auditIntegrity().valid, true);
});
test("cache cleanup fails closed on protection/readback failure and local hash mismatch", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    evict(
      f.store,
      { ...f.archive, verifyProtection: async () => false },
      f.id,
      config,
    ),
    /CACHE_ARCHIVE_VERIFICATION_FAILED/,
  );
  await assert.rejects(
    evict(f.store, { ...f.archive, verify: async () => false }, f.id, config),
    /CACHE_ARCHIVE_VERIFICATION_FAILED/,
  );
  fs.writeFileSync(f.playback, "damaged");
  await assert.rejects(
    evict(f.store, f.archive, f.id, config),
    /CACHE_HASH_MISMATCH/,
  );
  assert.ok(fs.existsSync(f.cached));
  assert.ok(fs.existsSync(f.playback));
});
test("holds, playback access and jobs arriving after preparation block every local unlink", async (t) => {
  for (const change of ["hold", "access", "job"]) {
    const f = await fixture(t);
    await assert.rejects(
      evict(f.store, f.archive, f.id, {
        ...config,
        afterPrepare() {
          if (change === "hold")
            f.store.put("holds", "new", {
              id: "new",
              cameraId: "one",
              start: f.s.start,
              end: f.s.end,
              state: "pending",
            });
          if (change === "access")
            f.store.put("cache-access", f.id, { at: f.store.now() });
          if (change === "job")
            f.store.enqueue({ kind: "playback-restore", segmentId: f.id });
        },
      }),
      /CACHE_STATE_CHANGED/,
    );
    assert.ok(fs.existsSync(f.cached));
    assert.ok(fs.existsSync(f.playback));
  }
});
test("restart reconciles a prepared eviction after unlink without erasing archive coverage", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    evict(f.store, f.archive, f.id, {
      ...config,
      afterPrepare() {
        fs.unlinkSync(f.playback);
        throw Error("SIMULATED_CRASH");
      },
    }),
    /SIMULATED_CRASH/,
  );
  const reopened = new Store(f.root, { now: f.store.now });
  try {
    reconcileCacheState(reopened);
    assert.equal(reopened.get("segments", f.id).derivative.video, null);
    assert.equal(reopened.get("segments", f.id).verified, true);
    assert.equal((await evict(reopened, f.archive, f.id, config)).removed, 1);
    assert.equal(reopened.get("cache-evictions", f.id).state, "complete");
    assert.equal(await f.local.verify(f.s.receipt), true);
  } finally {
    reopened.close();
  }
});
test("cache cleanup rejects symlinks, hard links and file replacement during verification", async (t) => {
  for (const change of ["symlink", "hardlink", "replacement"]) {
    const f = await fixture(t);
    if (change === "symlink") {
      fs.unlinkSync(f.cached);
      fs.symlinkSync(f.file, f.cached);
    }
    if (change === "hardlink") {
      fs.unlinkSync(f.cached);
      fs.linkSync(f.file, f.cached);
    }
    await assert.rejects(
      evict(f.store, f.archive, f.id, {
        ...config,
        ...(change === "replacement"
          ? {
              afterPrepare() {
                fs.unlinkSync(f.cached);
                fs.copyFileSync(f.file, f.cached);
                fs.chmodSync(f.cached, 0o600);
              },
            }
          : {}),
      }),
      /UNSAFE_CACHE_FILE|CACHE_FILE_CHANGED/,
    );
    assert.ok(fs.existsSync(f.file));
    assert.ok(fs.existsSync(f.playback));
  }
});
test("maintenance reports failed verification without touching local files", async (t) => {
  const f = await fixture(t);
  const result = await maintainCache(
    f.store,
    { ...f.archive, verify: async () => false },
    config,
  );
  assert.equal(result.removed, 0);
  assert.equal(result.failures[0].code, "CACHE_ARCHIVE_VERIFICATION_FAILED");
  assert.ok(fs.existsSync(f.cached));
  assert.ok(fs.existsSync(f.playback));
});
test("evicted playback rebuilds from preserved bytes after worker restart without contacting Ring", async (t) => {
  const f = await fixture(t, { video: true });
  await evict(f.store, f.archive, f.id, config);
  assert.equal(queuePlayback(f.store, f.owner, f.id).state, "queued");
  queuePlayback(f.store, f.owner, f.id);
  assert.equal(f.store.jobs().length, 1);
  const abandoned = f.store.claim();
  f.advance(600001);
  const restarted = new Store(f.root, { now: f.store.now });
  try {
    const job = restarted.claim();
    assert.notEqual(job.owner, abandoned.owner);
    const result = await processPlayback(restarted, f.archive, job);
    assert.equal(playbackStatus(restarted, f.owner, f.id).state, "ready");
    assert.equal(await hashFile(f.playback), result.derivative.sha256);
    assert.equal(await hashFile(f.file), f.s.sha256);
    assert.equal(await f.local.verify(f.s.receipt), true);
    assert.equal(
      fs
        .readdirSync(path.join(f.root, "staging"))
        .some((n) => n.endsWith(".restore.part")),
      false,
    );
    assert.equal(
      (await evict(restarted, f.archive, f.id, config)).removed,
      0,
      "recently rebuilt playback stays cached",
    );
  } finally {
    restarted.close();
  }
});
test("rebuild denies revoked users, expired requests, missing camera scope and read-only review", async (t) => {
  for (const change of ["disabled", "expired", "scope"]) {
    const f = await fixture(t);
    await evict(f.store, f.archive, f.id, config);
    assert.throws(
      () => queuePlayback(f.store, { ...f.owner, readOnly: true }, f.id),
      /REVIEW_IS_READ_ONLY/,
    );
    queuePlayback(f.store, f.owner, f.id);
    if (change === "disabled")
      f.store.put("users", f.owner.id, { ...f.owner, enabled: false });
    if (change === "scope")
      f.store.put("users", f.owner.id, {
        ...f.owner,
        enabled: true,
        cameraIds: ["other"],
      });
    if (change === "expired") f.advance(900001);
    let reads = 0;
    await assert.rejects(
      processPlayback(
        f.store,
        {
          ...f.archive,
          read: async () => {
            reads++;
            throw Error();
          },
        },
        f.store.claim(),
      ),
      /PLAYBACK_REQUEST_EXPIRED_OR_REVOKED/,
    );
    assert.equal(reads, 0);
  }
});
test("rebuild rejects short, altered and oversized archive bodies and removes temporary downloads", async (t) => {
  const f = await fixture(t);
  for (const bytes of [
    Buffer.from("short"),
    Buffer.alloc(f.s.bytes, 120),
    Buffer.alloc(f.s.bytes + 1),
  ]) {
    await assert.rejects(
      restoreDerivative(
        f.store,
        { read: async () => Readable.from([bytes]) },
        f.s,
      ),
      /ARCHIVE_READBACK_MISMATCH/,
    );
    assert.equal(
      fs
        .readdirSync(path.join(f.root, "staging"))
        .some((n) => n.endsWith(".restore.part")),
      false,
    );
  }
});
test("a grant revoked during archive readback cannot publish rebuilt playback", async (t) => {
  const f = await fixture(t, { video: true });
  await evict(f.store, f.archive, f.id, config);
  const inspector = {
    id: "inspector",
    name: "Fixture inspector",
    role: "inspector",
    cameraIds: ["one"],
    externalAuthenticated: true,
  };
  f.store.registerUser(inspector);
  const grant = f.store.grant(f.owner, {
    userId: inspector.id,
    cameraIds: ["one"],
    start: f.s.start,
    end: f.s.end,
    expiresAt: f.store.now() + 600000,
    requestId: "case fixture",
    purpose: "permission revocation fixture",
  });
  queuePlayback(f.store, inspector, f.id);
  const archive = {
    ...f.archive,
    read: async (r) => {
      f.store.revoke(f.owner, grant.id);
      return f.archive.read(r);
    },
  };
  await assert.rejects(
    processPlayback(f.store, archive, f.store.claim()),
    /PLAYBACK_REQUEST_EXPIRED_OR_REVOKED/,
  );
  assert.equal(f.store.get("segments", f.id).derivative.video, null);
  assert.equal(f.store.playbackReady(f.store.get("segments", f.id)), false);
});
test("job claims serialize original transfer and playback restoration for the same segment", async (t) => {
  const f = await fixture(t);
  const original = f.store.enqueue({
    kind: "ring-export",
    cameraId: "one",
    requestStart: 1,
    requestEnd: 2,
  });
  const restore = f.store.enqueue({
    kind: "playback-restore",
    segmentId: original,
  });
  const first = f.store.claim();
  assert.equal(first.id, original);
  assert.equal(f.store.claim(), null);
  f.store.finish(first, "complete");
  assert.equal(f.store.claim().id, restore);
});
