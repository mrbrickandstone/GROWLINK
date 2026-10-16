"use strict";
const { error, digest } = require("./store.cjs");
const { restoreDerivative } = require("./transfer.cjs");
function segmentFor(store, actor, id) {
  if (!/^[a-f0-9]{64}$/.test(id || "")) throw error("INVALID_SEGMENT_ID");
  const s = store.get("segments", id);
  if (!s?.verified || s.deletedAt) throw error("MEDIA_NOT_VERIFIED", 404);
  store.authorize(actor, "playback", s.cameraId, {
    start: s.start,
    end: s.end,
  });
  if (
    store
      .all("deletions")
      .some(
        (d) => d.segmentId === id && ["approved", "deleted"].includes(d.state),
      )
  )
    throw error("DELETION_INTENT_BLOCKS_PLAYBACK", 409);
  return s;
}
function jobPayload(id) {
  return { kind: "playback-restore", segmentId: id };
}
function playbackStatus(store, actor, id) {
  const s = segmentFor(store, actor, id);
  if (store.playbackReady(s)) return { segmentId: id, state: "ready" };
  const j = store.db
    .prepare("SELECT state,error FROM jobs WHERE id=?")
    .get(digest(JSON.stringify(jobPayload(id))));
  return {
    segmentId: id,
    state: !j || j.state === "complete" ? "unavailable" : j.state,
    ...(j?.error ? { error: j.error } : {}),
  };
}
function queuePlayback(store, actor, id) {
  if (store.recoveryPending()) throw error("RECOVERY_REVIEW_REQUIRED", 409);
  if (actor?.readOnly) throw error("REVIEW_IS_READ_ONLY", 403);
  if (!store.user(actor?.id)) throw error("NAMED_USER_REQUIRED", 403);
  actor = { ...actor, externalAuthenticated: true };
  return store.tx(() => {
    const s = segmentFor(store, actor, id);
    store.put("cache-access", id, { at: store.now() });
    if (!store.playbackReady(s)) {
      const jobId = store.enqueue(jobPayload(id));
      store.db
        .prepare(
          "UPDATE jobs SET state='queued',attempts=0,next=0,error=NULL,lease=NULL,owner=NULL WHERE id=? AND state NOT IN ('queued','running')",
        )
        .run(jobId);
      const requestId = digest(actor.id + "\n" + id);
      store.put("playback-requests", requestId, {
        id: requestId,
        userId: actor.id,
        segmentId: id,
        mfa: actor.mfa === true,
        createdAt: store.now(),
        expiresAt: store.now() + 900000,
      });
      store.audit(actor, "playback.prepare.requested", {
        segmentId: id,
        jobId,
      });
    }
    return playbackStatus(store, actor, id);
  });
}
function authorizedRequest(store, id) {
  for (const r of store
    .all("playback-requests")
    .filter(
      (r) =>
        r.segmentId === id &&
        r.createdAt <= store.now() &&
        r.expiresAt > store.now(),
    )) {
    const u = store.user(r.userId);
    if (!u) continue;
    const actor = { ...u, mfa: r.mfa, externalAuthenticated: true };
    try {
      return { actor, segment: segmentFor(store, actor, id) };
    } catch {}
  }
  throw error("PLAYBACK_REQUEST_EXPIRED_OR_REVOKED", 409);
}
async function processPlayback(store, archive, job, { disk } = {}) {
  if (store.recoveryPending()) throw error("RECOVERY_REVIEW_REQUIRED", 409);
  const id = job.payload.segmentId;
  const { segment } = authorizedRequest(store, id);
  if (store.playbackReady(segment)) {
    store.finish(job, "complete");
    return segment;
  }
  const derivative = await restoreDerivative(store, archive, segment, disk);
  return store.tx(() => {
    store.renew(job);
    const current = authorizedRequest(store, id).segment;
    if (
      current.sha256 !== segment.sha256 ||
      JSON.stringify(current.receipt) !== JSON.stringify(segment.receipt)
    )
      throw error("ARCHIVE_RECEIPT_CHANGED", 409);
    const updated = {
      ...current,
      derivative,
      cache: { ...current.cache, materializedAt: store.now() },
    };
    store.put("segments", id, updated);
    store.finish(job, "complete");
    store.audit({ id: "transfer-worker" }, "playback.prepared", {
      segmentId: id,
      sha256: derivative.sha256,
      source: "preserved-archive",
    });
    return updated;
  });
}
module.exports = { queuePlayback, playbackStatus, processPlayback };
