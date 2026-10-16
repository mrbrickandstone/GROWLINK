"use strict";
const { error, digest } = require("./store.cjs");
const HOUR = 3600000;
function options(env = {}) {
  const hours = env.SECURITY_ARCHIVE_VERIFY_HOURS || "168";
  if (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 720)
    throw error("INVALID_ARCHIVE_VERIFY_INTERVAL");
  return { intervalMs: Number(hours) * HOUR, batch: 20 };
}
function receiptKey(s) {
  return digest(
    JSON.stringify({
      sha256: s.sha256,
      bytes: s.bytes,
      objectKey: s.receipt?.objectKey,
      versionId: s.receipt?.versionId,
      receiptHash: s.receipt?.sha256,
      receiptSize: s.receipt?.size,
      independent: s.receipt?.independent,
    }),
  );
}
function deleted(store, s) {
  return (
    s.deletedAt ||
    store
      .all("deletions")
      .some(
        (d) =>
          d.segmentId === s.id && ["approved", "deleted"].includes(d.state),
      )
  );
}
function candidates(store) {
  const deleting = new Set(
    store
      .all("deletions")
      .filter((d) => ["approved", "deleted"].includes(d.state))
      .map((d) => d.segmentId),
  );
  return store
    .all("segments")
    .filter(
      (s) =>
        s.receipt &&
        !s.deletedAt &&
        !deleting.has(s.id) &&
        (s.verified || s.verificationError?.startsWith("ARCHIVE_")),
    );
}
function dueAt(store, s, config, record) {
  const last = record?.receiptKey === receiptKey(s) ? record : null;
  if (last && last.state !== "verified") return last.retryAt || 0;
  const at = last?.lastVerifiedAt || s.receipt.readbackVerifiedAt;
  return Number.isSafeInteger(at) && at > 0 && at <= store.now()
    ? at + config.intervalMs
    : 0;
}
function scheduleVerification(store, config = options()) {
  let added = 0;
  const now = store.now();
  const checks = new Map(
    store.all("archive-checks").map((r) => [r.segmentId, r]),
  );
  const due = candidates(store)
    .map((s) => ({ s, at: dueAt(store, s, config, checks.get(s.id)) }))
    .filter(({ at }) => at <= now)
    .sort((a, b) => a.at - b.at);
  store.tx(() => {
    for (const { s } of due.slice(0, config.batch)) {
      const payload = { kind: "archive-verify", segmentId: s.id },
        id = digest(JSON.stringify(payload));
      const j = store.db
        .prepare("SELECT state,next FROM jobs WHERE id=?")
        .get(id);
      if (!j) {
        store.enqueue(payload);
        added++;
      } else if (
        ["complete", "failed", "blocked"].includes(j.state) &&
        (j.state === "complete" || j.next <= now)
      ) {
        store.db
          .prepare(
            "UPDATE jobs SET state='queued',attempts=0,next=0,error=NULL,owner=NULL,lease=NULL WHERE id=?",
          )
          .run(id);
        added++;
      }
    }
  });
  return added;
}
async function inspectSegment(store, archive, id, { job } = {}) {
  const s = store.get("segments", id);
  if (!s || deleted(store, s)) return { state: "skipped" };
  if (!s.verified && !s.verificationError?.startsWith("ARCHIVE_"))
    throw error("MEDIA_NOT_VERIFIED", 409);
  const key = receiptKey(s);
  let result;
  if (s.receipt?.sha256 !== s.sha256 || s.receipt?.size !== s.bytes)
    result = { state: "unavailable", code: "ARCHIVE_RECEIPT_INVALID" };
  else
    try {
      result =
        typeof archive.inspect === "function"
          ? await archive.inspect(s.receipt)
          : {
              state: (await archive.verify(s.receipt))
                ? "verified"
                : "unavailable",
              code: "ARCHIVE_READBACK_UNAVAILABLE",
            };
    } catch {
      result = { state: "unavailable", code: "ARCHIVE_READBACK_UNAVAILABLE" };
    }
  if (
    !["verified", "missing", "mismatch", "unavailable"].includes(result?.state)
  )
    result = { state: "unavailable", code: "ARCHIVE_READBACK_UNAVAILABLE" };
  return store.tx(() => {
    if (job) store.renew(job);
    const current = store.get("segments", id);
    if (!current || deleted(store, current)) return { state: "skipped" };
    if (receiptKey(current) !== key)
      throw error("ARCHIVE_RECEIPT_CHANGED", 503);
    const previous = store.get("archive-checks", id),
      verified = result.state === "verified",
      now = store.now();
    const record = {
      segmentId: id,
      cameraId: current.cameraId,
      receiptKey: key,
      state: result.state,
      code: verified
        ? null
        : [
              "ARCHIVE_OBJECT_MISSING",
              "ARCHIVE_SIZE_MISMATCH",
              "ARCHIVE_READBACK_MISMATCH",
              "ARCHIVE_RECEIPT_INVALID",
              "ARCHIVE_READBACK_TIMEOUT",
            ].includes(result.code)
          ? result.code
          : "ARCHIVE_READBACK_UNAVAILABLE",
      checkedAt: now,
      lastVerifiedAt: verified
        ? now
        : (previous?.receiptKey === key && previous.lastVerifiedAt) ||
          current.receipt?.readbackVerifiedAt ||
          null,
      retryAt: verified ? null : now + HOUR,
      checks: (previous?.checks || 0) + 1,
    };
    store.put("archive-checks", id, record);
    store.put("segments", id, {
      ...current,
      verified,
      verificationError: verified ? null : record.code,
      receipt: verified
        ? { ...current.receipt, readbackVerifiedAt: now }
        : current.receipt,
    });
    store.audit(
      { id: "transfer-worker" },
      verified
        ? "archive.reconciliation.verified"
        : "archive.reconciliation.failed",
      {
        segmentId: id,
        state: record.state,
        code: record.code,
        versionId: current.receipt?.versionId,
        originalTransferUnchanged: true,
      },
    );
    return record;
  });
}
async function processVerification(store, archive, job) {
  const result = await inspectSegment(store, archive, job.payload.segmentId, {
    job,
  });
  if (!["verified", "skipped"].includes(result.state))
    throw error(result.code, 503);
  store.finish(job, "complete");
  return result;
}
function observeVerification(store, config = options()) {
  const now = store.now(),
    grace = Math.min(86400000, Math.max(HOUR, config.intervalMs / 4));
  const rows = store.all("cameras").map((c) => ({
    cameraId: c.id,
    observedAt: now,
    intervalHours: config.intervalMs / HOUR,
    checked: 0,
    due: 0,
    overdue: 0,
    failed: 0,
    missing: 0,
    mismatch: 0,
    unavailable: 0,
    oldestDueAt: null,
    lastCheckedAt: null,
  }));
  const byCamera = new Map(rows.map((r) => [r.cameraId, r]));
  const checks = new Map(
    store.all("archive-checks").map((r) => [r.segmentId, r]),
  );
  for (const s of candidates(store)) {
    const row = byCamera.get(s.cameraId);
    if (!row) continue;
    const record = checks.get(s.id),
      same = record?.receiptKey === receiptKey(s),
      due = dueAt(store, s, config, record);
    if (same) {
      row.checked++;
      row.lastCheckedAt = Math.max(row.lastCheckedAt || 0, record.checkedAt);
      if (record.state !== "verified") {
        row.failed++;
        row[record.state]++;
      }
    }
    if (due <= now) {
      row.due++;
      row.oldestDueAt =
        row.oldestDueAt === null ? due : Math.min(row.oldestDueAt, due);
      if (now - due > grace) row.overdue++;
    }
  }
  store.tx(() => {
    for (const row of rows) store.put("verification-health", row.cameraId, row);
  });
  const faultCodes = [];
  if (rows.some((r) => r.failed)) faultCodes.push("ARCHIVE_READBACK_FAILED");
  if (rows.some((r) => r.overdue))
    faultCodes.push("ARCHIVE_VERIFICATION_OVERDUE");
  return { rows, faultCodes };
}
module.exports = {
  options,
  scheduleVerification,
  inspectSegment,
  processVerification,
  observeVerification,
};
