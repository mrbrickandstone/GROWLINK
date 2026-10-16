"use strict";
const { coverage } = require("../../lib/security/coverage.cjs");
const DAY = 86400000,
  STEP = 299000,
  OVERLAP = 1000,
  READY_LAG = 300000;
const ADVERTISED_HISTORY_DAYS = 14,
  BACKLOG_WARNING = 900000;
const FAULT_CODES = [
  "DISK_SPACE_LOW",
  "DISK_SPACE_WARNING",
  "DISK_CAPACITY_UNKNOWN",
  "TRANSFER_FAILED",
  "ARCHIVE_BACKLOG",
  "ORIGINAL_BACKLOG",
  "SOURCE_WINDOW_AT_RISK",
  "SOURCE_WINDOW_EXCEEDED",
  "SOURCE_WINDOW_UNCONFIRMED",
  "PIPELINE_CONFIGURATION_INVALID",
  "RING_EXPORT_POLICY_BLOCKED",
  "EXPORTS_DISABLED",
  "PLAYBACK_BACKLOG",
  "SCHEDULER_FAILED",
  "PIPELINE_OBSERVATION_FAILED",
];
const FAULT_LABELS = {
  DISK_SPACE_LOW: "Transfers paused for low disk space",
  DISK_SPACE_WARNING: "Local storage running low",
  DISK_CAPACITY_UNKNOWN: "Disk capacity could not be checked",
  TRANSFER_FAILED: "A footage transfer needs recovery",
  ARCHIVE_BACKLOG: "Independent archive is behind",
  ORIGINAL_BACKLOG: "Original footage still needs preservation",
  SOURCE_WINDOW_AT_RISK:
    "Missing footage is approaching the estimated source limit",
  SOURCE_WINDOW_EXCEEDED:
    "Missing footage is beyond the estimated source limit",
  SOURCE_WINDOW_UNCONFIRMED: "Camera cloud-history setting needs confirmation",
  PIPELINE_CONFIGURATION_INVALID: "Recording configuration needs review",
  RING_EXPORT_POLICY_BLOCKED: "Unattended Ring exports need policy approval",
  EXPORTS_DISABLED: "Recording exports are disabled",
  PLAYBACK_BACKLOG:
    "Playback copies need recovery; preserved originals are separate",
  SCHEDULER_FAILED: "New transfer scheduling failed",
  PIPELINE_OBSERVATION_FAILED: "Transfer monitoring failed",
};
function policyApproved(store) {
  const p = store.get("policy", "ring");
  return (
    p?.automatedExportsApproved === true &&
    typeof p.decisionReference === "string" &&
    !!p.decisionReference.trim()
  );
}
function validCamera(c, now) {
  return (
    Number.isSafeInteger(c.enabledAt) && c.enabledAt > 0 && c.enabledAt <= now
  );
}
function readyThrough(c, now) {
  return (
    c.enabledAt +
    Math.max(0, Math.floor((now - READY_LAG - c.enabledAt) / STEP)) * STEP
  );
}
function scheduleRing(store, { batchPerCamera = 120 } = {}) {
  if (!policyApproved(store)) return 0;
  if (
    !Number.isSafeInteger(batchPerCamera) ||
    batchPerCamera < 1 ||
    batchPerCamera > 1000
  )
    throw Error("INVALID_SCHEDULER_BATCH");
  const now = store.now();
  let added = 0;
  for (const c of store
    .all("cameras")
    .filter((c) => c.source === "ring" && c.exportEnabled)) {
    if (!validCamera(c, now)) continue;
    store.tx(() => {
      const previous = store.get("schedules", c.id);
      // A configuration change cannot silently discard the previous recording obligation.
      if (previous && previous.enabledAt !== c.enabledAt) return;
      const oldestCandidate =
        c.enabledAt +
        Math.max(
          0,
          Math.floor(
            (now - ADVERTISED_HISTORY_DAYS * DAY - c.enabledAt) / STEP,
          ),
        ) *
          STEP;
      const cursor = previous || {
        cameraId: c.id,
        enabledAt: c.enabledAt,
        nextStart: c.enabledAt,
        initializedAt: now,
      };
      if (cursor.nextStart < oldestCandidate) {
        const skipped = {
          start: cursor.nextStart,
          end: oldestCandidate,
          at: now,
          reason:
            "Outside advertised retrieval window; coverage remains unverified",
        };
        store.audit(
          { id: "transfer-worker" },
          "schedule.unretrieved.interval",
          { cameraId: c.id, ...skipped },
        );
        cursor.lastSkipped = skipped;
        cursor.nextStart = oldestCandidate;
      }
      if (!previous)
        store.audit({ id: "transfer-worker" }, "schedule.initialized", {
          cameraId: c.id,
          enabledAt: c.enabledAt,
          nextStart: cursor.nextStart,
        });
      let n = 0;
      const ready = readyThrough(c, now);
      while (n < batchPerCamera && cursor.nextStart + STEP <= ready) {
        store.enqueue({
          kind: "ring-export",
          cameraId: c.id,
          requestStart: Math.max(c.enabledAt, cursor.nextStart - OVERLAP),
          requestEnd: cursor.nextStart + STEP,
        });
        added += store.db.prepare("SELECT changes() AS n").get().n;
        cursor.nextStart += STEP;
        n++;
      }
      cursor.lastScheduledAt = now;
      cursor.readyThrough = ready;
      store.put("schedules", c.id, cursor);
    });
  }
  return added;
}
function emptyCoverage() {
  return { gaps: [], coveredMs: 0, requestedMs: 0 };
}
function gapSummary(result) {
  return {
    missingMs: result.requestedMs - result.coveredMs,
    gapCount: result.gaps.length,
    oldestMissingAt: result.gaps[0]?.start ?? null,
    firstGaps: result.gaps.slice(0, 5),
  };
}
function assessPipelines(store) {
  const now = store.now(),
    segments = store.all("segments"),
    jobs = new Map();
  for (const row of store.db
    .prepare("SELECT id,payload,state FROM jobs WHERE state!='complete'")
    .iterate()) {
    const p = JSON.parse(row.payload);
    if (!["ring-export", "pilot-import"].includes(p.kind)) continue;
    const list = jobs.get(p.cameraId) || [];
    list.push({ ...p, id: row.id, state: row.state });
    jobs.set(p.cameraId, list);
  }
  return store
    .all("cameras")
    .filter((c) => c.source === "ring")
    .map((c) => {
      const cursor = store.get("schedules", c.id),
        configured = c.exportEnabled || !!cursor;
      const result = {
        cameraId: c.id,
        observedAt: now,
        configured: !!configured,
        status: "not_configured",
        faultCodes: [],
        sourceHistoryDays: null,
        historyBasis: "unconfirmed",
        availabilityGuaranteed: false,
      };
      if (!configured) return result;
      if (
        !validCamera(c, now) ||
        (cursor && cursor.enabledAt !== c.enabledAt)
      ) {
        return {
          ...result,
          status: "unknown",
          faultCodes: ["PIPELINE_CONFIGURATION_INVALID"],
        };
      }
      const confirmed =
        Number.isSafeInteger(c.continuousHistoryDays) &&
        c.continuousHistoryDays >= 1 &&
        c.continuousHistoryDays <= ADVERTISED_HISTORY_DAYS &&
        typeof c.continuousHistoryEvidence === "string" &&
        !!c.continuousHistoryEvidence.trim();
      result.sourceHistoryDays = confirmed
        ? c.continuousHistoryDays
        : ADVERTISED_HISTORY_DAYS;
      result.historyBasis = confirmed
        ? "configured-setting"
        : "advertised-maximum-only";
      result.readyThrough = readyThrough(c, now);
      const requests = [
        {
          start: Math.max(c.enabledAt, now - 90 * DAY),
          end: result.readyThrough,
        },
        ...store
          .all("holds")
          .filter((h) => h.cameraId === c.id && h.state !== "released")
          .map((h) => ({
            start: Math.max(c.enabledAt, h.start),
            end: Math.min(result.readyThrough, h.end),
          })),
      ].filter(
        (w) =>
          Number.isSafeInteger(w.start) &&
          Number.isSafeInteger(w.end) &&
          w.end > w.start,
      );
      result.requiredWindows = requests.length
        ? coverage(
            Math.min(...requests.map((w) => w.start)),
            result.readyThrough,
            requests.map((w) => ({ ...w, verified: true })),
          ).intervals
        : [];
      result.requiredFrom = result.requiredWindows[0]?.start ?? null;
      const valid = segments.filter(
        (s) =>
          s.cameraId === c.id &&
          s.verified === true &&
          !s.deletedAt &&
          Number.isSafeInteger(s.receipt?.readbackVerifiedAt) &&
          s.receipt.readbackVerifiedAt > 0 &&
          s.receipt.readbackVerifiedAt <= now,
      );
      const ranges = (spans) =>
        result.requiredWindows.reduce((total, w) => {
          const part = coverage(w.start, w.end, spans);
          total.gaps.push(...part.gaps);
          total.coveredMs += part.coveredMs;
          total.requestedMs += part.requestedMs;
          return total;
        }, emptyCoverage());
      result.originals = gapSummary(ranges(valid));
      result.archive = gapSummary(
        ranges(valid.filter((s) => s.receipt.independent === true)),
      );
      result.originals.oldestAgeMs =
        result.originals.oldestMissingAt === null
          ? 0
          : now - result.originals.oldestMissingAt;
      result.archive.oldestAgeMs =
        result.archive.oldestMissingAt === null
          ? 0
          : now - result.archive.oldestMissingAt;
      result.sourceWindowBoundaryAt =
        result.originals.oldestMissingAt === null
          ? null
          : result.originals.oldestMissingAt + result.sourceHistoryDays * DAY;
      result.sourceWindowRemainingMs =
        result.sourceWindowBoundaryAt === null
          ? null
          : result.sourceWindowBoundaryAt - now;
      const pending = jobs.get(c.id) || [];
      result.jobs = {
        pending: pending.length,
        failed: pending.filter((j) => ["blocked", "failed"].includes(j.state))
          .length,
      };
      result.scheduledThrough = cursor?.nextStart ?? null;
      if (!c.exportEnabled) result.faultCodes.push("EXPORTS_DISABLED");
      if (!policyApproved(store))
        result.faultCodes.push("RING_EXPORT_POLICY_BLOCKED");
      if (!confirmed) result.faultCodes.push("SOURCE_WINDOW_UNCONFIRMED");
      if (result.originals.oldestAgeMs >= BACKLOG_WARNING)
        result.faultCodes.push("ORIGINAL_BACKLOG");
      if (result.archive.oldestAgeMs >= BACKLOG_WARNING)
        result.faultCodes.push("ARCHIVE_BACKLOG");
      if (result.sourceWindowRemainingMs !== null) {
        if (result.sourceWindowRemainingMs <= 0)
          result.faultCodes.push("SOURCE_WINDOW_EXCEEDED");
        else if (
          result.sourceWindowRemainingMs <=
          Math.min(2 * DAY, (result.sourceHistoryDays * DAY) / 4)
        )
          result.faultCodes.push("SOURCE_WINDOW_AT_RISK");
      }
      const failed = pending.filter((j) =>
        ["blocked", "failed"].includes(j.state),
      );
      if (failed.some((j) => !valid.some((s) => s.id === j.id)))
        result.faultCodes.push("TRANSFER_FAILED");
      if (failed.some((j) => valid.some((s) => s.id === j.id && !s.derivative)))
        result.faultCodes.push("PLAYBACK_BACKLOG");
      result.status = result.faultCodes.includes("SOURCE_WINDOW_EXCEEDED")
        ? "outside_window"
        : result.faultCodes.includes("SOURCE_WINDOW_AT_RISK")
          ? "at_risk"
          : result.faultCodes.some((code) =>
                ["EXPORTS_DISABLED", "RING_EXPORT_POLICY_BLOCKED"].includes(
                  code,
                ),
              )
            ? "blocked"
            : result.faultCodes.some(
                  (code) => code !== "SOURCE_WINDOW_UNCONFIRMED",
                )
              ? "behind"
              : !confirmed
                ? "unknown"
                : "current";
      return result;
    });
}
function observePipelines(store) {
  const rows = assessPipelines(store);
  store.tx(() => {
    for (const row of rows) {
      row.faultReasons = row.faultCodes.map((code) => FAULT_LABELS[code]);
      const previous = store.get("pipeline-health", row.cameraId);
      if (
        (previous &&
          JSON.stringify(previous.faultCodes) !==
            JSON.stringify(row.faultCodes)) ||
        (!previous && row.faultCodes.length)
      )
        store.audit({ id: "transfer-worker" }, "pipeline.health.changed", {
          cameraId: row.cameraId,
          from: previous?.faultCodes || [],
          to: row.faultCodes,
          oldestMissingOriginalAt: row.originals?.oldestMissingAt ?? null,
          oldestMissingArchiveAt: row.archive?.oldestMissingAt ?? null,
        });
      store.put("pipeline-health", row.cameraId, row);
    }
  });
  return {
    rows,
    faultCodes: [...new Set(rows.flatMap((r) => r.faultCodes))].sort(),
  };
}
module.exports = {
  scheduleRing,
  assessPipelines,
  observePipelines,
  FAULT_CODES,
  FAULT_LABELS,
  DAY,
  STEP,
  READY_LAG,
  BACKLOG_WARNING,
};
