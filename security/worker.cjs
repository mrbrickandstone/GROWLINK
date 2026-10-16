"use strict";
process.umask(0o077);
const path = require("node:path");
const { Store } = require("./server/store.cjs");
const { archiveFor } = require("./server/archive.cjs");
const { observePipelines } = require("./server/pipeline.cjs");
const {
  options: cacheOptions,
  maintainCache,
  reconcileCacheState,
} = require("./server/cache.cjs");
const cacheConfig = cacheOptions(process.env);
const {
  options: verificationOptions,
  scheduleVerification,
  processVerification,
  observeVerification,
} = require("./server/reconciliation.cjs");
const verificationConfig = verificationOptions(process.env);
const {
  DiskGuard,
  JOB_HEADROOM,
  capacityError,
} = require("./server/capacity.cjs");
const {
  transfer,
  buildPlayback,
  reconcileHolds,
  scheduleRing,
} = require("./server/transfer.cjs");
const store = new Store(
    process.env.SECURITY_DATA_DIR || path.join(__dirname, "../.security"),
  ),
  archive = archiveFor(process.env, store.root),
  once = process.argv.includes("--once");
const disk = new DiskGuard(store.root, {
  paused: store.get("heartbeats", "archive-worker")?.disk?.paused === true,
});
let stopped = false,
  lastCacheCheck = null,
  cacheFault = false,
  lastError = null,
  activeJob = null;
async function beat() {
  if (activeJob) store.renew(activeJob);
  const capacity = disk.inspect(activeJob ? 0 : JOB_HEADROOM);
  const faultCodes = [];
  const backup = require("./server/backup-scheduler.cjs").observe(
    process.env,
    store.now(),
  );
  faultCodes.push(...backup.faultCodes);
  if (store.recoveryPending()) faultCodes.push("RECOVERY_REVIEW_REQUIRED");
  if (cacheFault) faultCodes.push("CACHE_MAINTENANCE_FAILED");
  try {
    if (!stopped) scheduleVerification(store, verificationConfig);
    faultCodes.push(
      ...observeVerification(store, verificationConfig).faultCodes,
    );
  } catch {
    faultCodes.push("ARCHIVE_VERIFICATION_SCHEDULER_FAILED");
  }
  if (capacity.code) faultCodes.push(capacity.code);
  if (!capacity.paused && !stopped) {
    try {
      scheduleRing(store);
    } catch {
      faultCodes.push("SCHEDULER_FAILED");
    }
  }
  try {
    faultCodes.push(...observePipelines(store).faultCodes);
  } catch {
    faultCodes.push("PIPELINE_OBSERVATION_FAILED");
  }
  const failureRows = store.db
    .prepare(
      "SELECT json_extract(payload,'$.kind') AS kind FROM jobs WHERE state IN ('blocked','failed') OR (state='queued' AND error IS NOT NULL)",
    )
    .all();
  const failures = failureRows.length,
    verificationFailures = failureRows.filter(
      (r) => r.kind === "archive-verify",
    ).length,
    playbackFailures = failureRows.filter((r) =>
      ["playback-build", "playback-restore"].includes(r.kind),
    ).length;
  if (playbackFailures) faultCodes.push("PLAYBACK_BACKLOG");
  if (verificationFailures) faultCodes.push("ARCHIVE_READBACK_FAILED");
  if (
    failures > playbackFailures + verificationFailures ||
    (lastError && !playbackFailures && !verificationFailures)
  )
    faultCodes.push("TRANSFER_FAILED");
  const detail = {
    status:
      capacity.state === "unknown"
        ? "unknown"
        : faultCodes.length
          ? "failed"
          : "ok",
    detail:
      capacity.code ||
      lastError ||
      faultCodes[0] ||
      (failures
        ? "Transfer failures require recovery"
        : "Worker running; this does not establish camera capture health"),
    unresolvedJobs: failures,
    faultCodes: [...new Set(faultCodes)].sort(),
    disk: capacity,
    backup,
  };
  const previous = store.get("heartbeats", "archive-worker")?.disk;
  if (previous?.state !== capacity.state)
    store.audit({ id: "transfer-worker" }, "worker.capacity.changed", {
      from: previous?.state || "unobserved",
      to: capacity.state,
      freeBytes: capacity.freeBytes,
      paused: capacity.paused,
    });
  store.heartbeat("archive-worker", detail);
  if (
    process.env.SECURITY_WATCHDOG_URL &&
    process.env.SECURITY_WATCHDOG_TOKEN
  ) {
    try {
      if (new URL(process.env.SECURITY_WATCHDOG_URL).protocol !== "https:")
        throw Error();
      const r = await fetch(
        new URL("/heartbeat", process.env.SECURITY_WATCHDOG_URL),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.SECURITY_WATCHDOG_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            component: "archive-worker",
            status: detail.status,
            faultCodes: detail.faultCodes,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      await r.body?.cancel();
      if (!r.ok) throw Error();
    } catch {
      store.heartbeat("watchdog-delivery", {
        status: "failed",
        detail: "Heartbeat endpoint unreachable",
      });
    }
  }
}
const timer = setInterval(() => beat().catch(() => {}), 30000);
timer.unref();
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => {
    stopped = true;
  });
(async () => {
  await beat();
  reconcileCacheState(store);
  await beat();
  let ring;
  if (
    !store.recoveryPending() &&
    store.get("policy", "ring")?.automatedExportsApproved
  )
    ring = require("../lib/ring.cjs").client(process.env);
  do {
    await cacheMaintenance();
    await reconcileHolds(store, archive);
    let job;
    while (
      !stopped &&
      (job = store.claim({
        verificationOnly: disk.inspect(JOB_HEADROOM).paused,
      }))
    ) {
      try {
        activeJob = job;
        await reconcileHolds(store, archive);
        if (
          !ring &&
          job.payload.kind === "ring-export" &&
          !store.recoveryPending() &&
          store.get("policy", "ring")?.automatedExportsApproved
        )
          ring = require("../lib/ring.cjs").client(process.env);
        if (job.payload.kind === "archive-verify")
          await processVerification(store, archive, job);
        else if (job.payload.kind === "evidence-export")
          await require("./server/evidence.cjs").processEvidence(
            store,
            archive,
            job,
          );
        else if (job.payload.kind === "playback-build")
          await buildPlayback(store, archive, job, { disk });
        else if (job.payload.kind === "playback-restore")
          await require("./server/playback.cjs").processPlayback(
            store,
            archive,
            job,
            { disk },
          );
        else await transfer(store, archive, job, { ring, disk });
        activeJob = null;
        lastError = null;
        console.log(JSON.stringify({ job: job.id, state: "complete" }));
      } catch (e) {
        activeJob = null;
        if (capacityError(e)) {
          lastError =
            e.message === "DISK_CAPACITY_UNKNOWN"
              ? e.message
              : "DISK_SPACE_LOW";
          disk.paused = true;
          store.deferForCapacity(job, lastError);
          if (job.payload.kind === "evidence-export") {
            const record = store.get("exports", job.payload.exportId);
            store.put("exports", record.id, {
              ...record,
              state: "queued",
              error: lastError,
            });
          }
          await beat();
          break;
        }
        lastError = /^[A-Z_0-9]+$/.test(e.message)
          ? e.message
          : "TRANSFER_FAILED";
        const state =
          e.status === 409
            ? "blocked"
            : job.attempts >= 5
              ? "failed"
              : "queued";
        store.finish(job, state, lastError, e.retryAt);
        if (job.payload.kind === "evidence-export") {
          const e = store.get("exports", job.payload.exportId);
          store.put("exports", e.id, {
            ...e,
            state: state === "queued" ? "queued" : "failed",
            error: lastError,
          });
        }
        console.log(JSON.stringify({ job: job.id, state, error: lastError }));
      }
      await beat();
      await cacheMaintenance();
    }
    await beat();
    if (process.env.SECURITY_ENABLE_PHYSICAL_DELETION === "true") {
      for (const r of store
        .all("deletions")
        .filter((r) => r.state === "approved")) {
        try {
          await require("./server/deletion.cjs").executeDeletion(
            store,
            archive,
            r.id,
          );
        } catch {
          lastError = "DELETION_BLOCKED_REQUIRES_REVIEW";
        }
      }
    }
    if (once || stopped) break;
    await new Promise((r) => setTimeout(r, 30000));
  } while (!stopped);
})()
  .catch(() => {
    console.error("WORKER_STOPPED_WITH_ERROR");
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(timer);
    store.close();
  });
async function cacheMaintenance() {
  if (
    !cacheConfig.enabled ||
    (lastCacheCheck !== null && store.now() - lastCacheCheck < 300000)
  )
    return;
  lastCacheCheck = store.now();
  try {
    const result = await maintainCache(store, archive, cacheConfig);
    cacheFault =
      result.failures?.length > 0 ||
      store.all("cache-assessments").some((r) => r.error);
    store.heartbeat("cache-maintenance", {
      ...result,
      status: cacheFault ? "failed" : "ok",
    });
  } catch {
    cacheFault = true;
  }
}
