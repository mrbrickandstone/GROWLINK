"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { hashFile } = require("../../lib/security/ring-pilot.cjs");
const { DAY, error, digest } = require("./store.cjs");
const HEX = /^[a-f0-9]{64}$/;
function options(env = {}) {
  const hours = env.SECURITY_CACHE_KEEP_HOURS || "24";
  if (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 720)
    throw error("INVALID_CACHE_AGE");
  return {
    enabled: env.SECURITY_ENABLE_CACHE_EVICTION === "true",
    keepMs: Number(hours) * 3600000,
  };
}
function eligible(store, s, keepMs) {
  if (!Number.isSafeInteger(keepMs) || keepMs < 3600000) return false;
  if (
    !s ||
    !HEX.test(s.id) ||
    !HEX.test(s.sha256) ||
    !s.verified ||
    s.deletedAt ||
    !Number.isSafeInteger(s.ingestedAt) ||
    !Number.isSafeInteger(s.end) ||
    !s.receipt?.independent ||
    !s.receipt.immutableStorageVerified ||
    s.receipt.sha256 !== s.sha256 ||
    s.receipt.size !== s.bytes
  )
    return false;
  if (
    s.source === "ring" &&
    (!store.get("policy", "ring")?.retentionApproved ||
      !store.get("policy", "ring")?.decisionReference)
  )
    return false;
  if (
    store.held(s).length ||
    store
      .all("deletions")
      .some(
        (d) =>
          d.segmentId === s.id &&
          ["requested", "approved", "deleted"].includes(d.state),
      )
  )
    return false;
  if (
    store.db
      .prepare(
        "SELECT 1 FROM jobs WHERE (id=? OR json_extract(payload,'$.segmentId')=?) AND (state='running' OR (state='queued' AND COALESCE(json_extract(payload,'$.kind'),'')!='playback-build')) LIMIT 1",
      )
      .get(s.id, s.id)
  )
    return false;
  const newestUse = Math.max(
    s.ingestedAt,
    s.cache?.materializedAt || 0,
    store.get("cache-access", s.id)?.at || 0,
  );
  return newestUse > 0 && store.now() - newestUse >= keepMs;
}
function localFile(store, relative) {
  const root = fs.realpathSync(store.root),
    full = path.join(root, relative),
    parent = path.dirname(full);
  if (!full.startsWith(root + path.sep) || fs.realpathSync(parent) !== parent)
    throw error("UNSAFE_CACHE_PATH", 409);
  const stat = fs.lstatSync(full);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    ![0, process.getuid()].includes(stat.uid)
  )
    throw error("UNSAFE_CACHE_FILE", 409);
  return {
    full,
    stat,
    identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(
      ":",
    ),
  };
}
async function inventory(store, s) {
  const candidates = [
    { relative: `staging/originals/${s.id}.${s.sha256}.mp4`, sha256: s.sha256 },
    { relative: `staging/${s.id}.resume.mp4`, sha256: s.sha256 },
    ...(s.derivative?.video === s.id + ".mp4" &&
    HEX.test(s.derivative.sha256 || "")
      ? [{ relative: `derivatives/${s.id}.mp4`, sha256: s.derivative.sha256 }]
      : []),
  ];
  const files = [];
  for (const candidate of candidates) {
    let found;
    try {
      found = localFile(store, candidate.relative);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if ((await hashFile(found.full)) !== candidate.sha256)
      throw error("CACHE_HASH_MISMATCH", 409);
    files.push({
      ...candidate,
      bytes: found.stat.size,
      identity: found.identity,
    });
  }
  return files;
}
function reconcileCacheState(store) {
  for (const intent of store
    .all("cache-evictions")
    .filter((i) => i.state === "prepared")) {
    const s = store.get("segments", intent.segmentId);
    if (!s || !s.derivative?.video) continue;
    const expected = `derivatives/${s.id}.mp4`;
    if (
      s.derivative.video !== s.id + ".mp4" ||
      !intent.files.some((f) => f.relative === expected)
    )
      continue;
    if (!fs.existsSync(path.join(store.root, expected)))
      store.tx(() => {
        store.put("segments", s.id, {
          ...s,
          derivative: { ...s.derivative, video: null, sha256: null },
        });
        store.audit(
          { id: "transfer-worker" },
          "cache.missing.derivative.reconciled",
          { segmentId: s.id },
        );
      });
  }
}
async function evict(
  store,
  archive,
  id,
  { enabled = false, keepMs = DAY, afterPrepare } = {},
) {
  if (
    !enabled ||
    !archive.independent ||
    !archive.lockApproved ||
    typeof archive.verifyProtection !== "function"
  )
    return { removed: 0, bytes: 0 };
  const s = store.get("segments", id);
  if (!eligible(store, s, keepMs)) return { removed: 0, bytes: 0 };
  const files = await inventory(store, s);
  const priorIntent = store.get("cache-evictions", id);
  if (!files.length && priorIntent?.state !== "prepared")
    return { removed: 0, bytes: 0 };
  const until = Math.max(
    s.ingestedAt + 90 * DAY,
    s.end + 60 * DAY,
    store.now() + DAY,
  );
  if (
    !(await archive.verifyProtection(s.receipt, until)) ||
    !(await archive.verify(s.receipt))
  )
    throw error("CACHE_ARCHIVE_VERIFICATION_FAILED", 503);
  const verifiedAt = store.now(),
    receiptHash = digest(JSON.stringify(s.receipt));
  store.tx(() => {
    if (!eligible(store, store.get("segments", id), keepMs))
      throw error("CACHE_STATE_CHANGED", 409);
    store.put("cache-evictions", id, {
      segmentId: id,
      state: "prepared",
      files,
      receiptHash,
      verifiedAt,
    });
    store.audit({ id: "transfer-worker" }, "cache.eviction.prepared", {
      segmentId: id,
      files: files.map((f) => f.relative),
      archiveVersion: s.receipt.versionId,
      verifiedAt,
    });
  });
  await afterPrepare?.(); // Test fault-injection hook; never configured by the service.
  return store.tx(() => {
    const current = store.get("segments", id);
    if (
      !eligible(store, current, keepMs) ||
      digest(JSON.stringify(current.receipt)) !== receiptHash ||
      store.now() < verifiedAt ||
      store.now() - verifiedAt > 60000
    )
      throw error("CACHE_STATE_CHANGED", 409);
    // Validate every candidate again before removing any bytes. The short transaction
    // serializes holds, playback access and job admission against this local unlink.
    for (const file of files)
      if (localFile(store, file.relative).identity !== file.identity)
        throw error("CACHE_FILE_CHANGED", 409);
    let bytes = 0;
    for (const file of files) {
      fs.unlinkSync(path.join(store.root, file.relative));
      bytes += file.bytes;
    }
    for (const dir of new Set(
      files.map((f) => path.dirname(path.join(store.root, f.relative))),
    )) {
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const videoRemoved =
      files.some((f) => f.relative === `derivatives/${id}.mp4`) ||
      !fs.existsSync(path.join(store.root, "derivatives", id + ".mp4"));
    store.put("segments", id, {
      ...current,
      derivative:
        videoRemoved && current.derivative
          ? { ...current.derivative, video: null, sha256: null }
          : current.derivative,
      cache: {
        ...current.cache,
        evictedAt: store.now(),
        originalsEvicted: true,
      },
    });
    store.put("cache-evictions", id, {
      ...store.get("cache-evictions", id),
      state: "complete",
      completedAt: store.now(),
      bytes,
    });
    store.audit({ id: "transfer-worker" }, "cache.eviction.completed", {
      segmentId: id,
      files: files.map((f) => f.relative),
      bytes,
      originalArchiveUnchanged: true,
    });
    return { removed: files.length, bytes };
  });
}
async function maintainCache(store, archive, config) {
  if (!config.enabled) return { enabled: false, removed: 0, bytes: 0 };
  reconcileCacheState(store);
  let removed = 0,
    bytes = 0,
    checked = 0;
  const failures = [];
  const candidates = store
    .all("segments")
    .filter(
      (s) =>
        eligible(store, s, config.keepMs) &&
        (!s.cache?.originalsEvicted ||
          s.derivative?.video ||
          store.get("cache-evictions", s.id)?.state === "prepared"),
    )
    .sort(
      (a, b) =>
        (store.get("cache-assessments", a.id)?.at || 0) -
          (store.get("cache-assessments", b.id)?.at || 0) ||
        a.ingestedAt - b.ingestedAt,
    );
  for (const s of candidates.slice(0, 5)) {
    try {
      const result = await evict(store, archive, s.id, config);
      removed += result.removed;
      bytes += result.bytes;
      store.put("cache-assessments", s.id, { at: store.now(), error: null });
    } catch (e) {
      const code = /^[A-Z_0-9]+$/.test(e.message)
        ? e.message
        : "CACHE_MAINTENANCE_FAILED";
      store.put("cache-assessments", s.id, { at: store.now(), error: code });
      failures.push({ segmentId: s.id, code });
    }
    checked++;
  }
  return {
    enabled: true,
    checked,
    removed,
    bytes,
    failures,
    checkedAt: store.now(),
  };
}
module.exports = {
  options,
  eligible,
  inventory,
  evict,
  maintainCache,
  reconcileCacheState,
};
