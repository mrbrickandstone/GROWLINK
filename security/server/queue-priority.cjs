"use strict";
const DAY = 86400000;
const QUEUE_INDEXES = {
  jobs_ready: "CREATE INDEX jobs_ready ON jobs(state,next)",
  jobs_active_segment:
    "CREATE INDEX jobs_active_segment ON jobs(COALESCE(json_extract(payload,'$.segmentId'),id),lease) WHERE state='running'",
};
function historyEstimate(camera) {
  const confirmed =
    Number.isSafeInteger(camera?.continuousHistoryDays) &&
    camera.continuousHistoryDays >= 1 &&
    camera.continuousHistoryDays <= 14 &&
    typeof camera.continuousHistoryEvidence === "string" &&
    !!camera.continuousHistoryEvidence.trim();
  return {
    days: confirmed ? camera.continuousHistoryDays : 14,
    basis: confirmed ? "configured-setting" : "advertised-maximum-only",
  };
}
function preserved(s, now) {
  return (
    s?.verified === true &&
    !s.deletedAt &&
    /^[a-f0-9]{64}$/.test(s.sha256 || "") &&
    s.bytes > 0 &&
    s.receipt?.sha256 === s.sha256 &&
    s.receipt?.size === s.bytes &&
    Number.isSafeInteger(s.receipt?.readbackVerifiedAt) &&
    s.receipt.readbackVerifiedAt > 0 &&
    s.receipt.readbackVerifiedAt <= now
  );
}
function priority(payload, segment, camera, now) {
  let tier = 2,
    order = 0,
    reason = "requested-support-work",
    deadline = null,
    basis = null;
  if (
    ["ring-export", "pilot-import", "recorder-export"].includes(payload.kind) &&
    !preserved(segment, now)
  ) {
    tier = 1;
    reason = "original-preservation";
    order =
      Number.isSafeInteger(payload.requestStart) && payload.requestStart > 0
        ? payload.requestStart
        : 0;
    if (
      payload.kind === "ring-export" &&
      Number.isSafeInteger(payload.requestStart) &&
      payload.requestStart > 0
    ) {
      const estimate = historyEstimate(camera);
      deadline = payload.requestStart + estimate.days * DAY;
      basis = estimate.basis;
      if (Number.isSafeInteger(deadline) && deadline > now) {
        tier = 0;
        reason = "original-within-estimated-source-window";
        order = deadline;
      } else reason = "original-beyond-estimated-source-window";
    }
  } else if (payload.kind === "archive-verify") {
    tier = 3;
    reason = "scheduled-archive-readback";
  } else if (payload.kind === "playback-build") {
    tier = 4;
    reason = "background-playback";
  }
  // This rank is only queue ordering. It neither proves availability nor changes
  // request timestamps, retry deadlines, permission gates or coverage credit.
  const bounded = Math.min(Math.max(order, 0), 999999999999999);
  return {
    key: `${tier}|${String(bounded).padStart(16, "0")}`,
    reason,
    estimatedSourceBoundaryAt: deadline,
    historyBasis: basis,
    availabilityGuaranteed: false,
  };
}
function sqlRank(payload, segment, camera, now) {
  try {
    return priority(
      JSON.parse(payload),
      segment ? JSON.parse(segment) : null,
      camera ? JSON.parse(camera) : null,
      now,
    ).key;
  } catch {
    return "9|9999999999999999";
  }
}
module.exports = { historyEstimate, priority, sqlRank, QUEUE_INDEXES };
