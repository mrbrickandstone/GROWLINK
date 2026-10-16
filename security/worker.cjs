"use strict";
process.umask(0o077);
const path = require("node:path");
const { Store } = require("./server/store.cjs");
const { archiveFor } = require("./server/archive.cjs");
const {
  DiskGuard,
  JOB_HEADROOM,
  capacityError,
} = require("./server/capacity.cjs");
const {
  transfer,
  reconcile,
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
  lastError = null,
  activeJob = null;
async function beat() {
  if (activeJob) store.renew(activeJob);
  const capacity = disk.inspect(activeJob ? 0 : JOB_HEADROOM);
  const failures = store.db
    .prepare(
      "SELECT count(*) AS n FROM jobs WHERE state IN ('blocked','failed') OR (state='queued' AND error IS NOT NULL)",
    )
    .get().n;
  const detail = {
    status:
      capacity.state === "unknown"
        ? "unknown"
        : capacity.code || lastError || failures
          ? "failed"
          : "ok",
    detail:
      capacity.code ||
      lastError ||
      (failures
        ? "Transfer failures require recovery"
        : "Worker running; this does not establish camera capture health"),
    unresolvedJobs: failures,
    disk: capacity,
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
  await reconcile(store, archive);
  await beat();
  let ring;
  if (store.get("policy", "ring")?.automatedExportsApproved)
    ring = require("../lib/ring.cjs").client(process.env);
  do {
    await reconcileHolds(store, archive);
    if (!disk.inspect(JOB_HEADROOM).paused) scheduleRing(store);
    let job;
    while (
      !stopped &&
      !disk.inspect(JOB_HEADROOM).paused &&
      (job = store.claim())
    ) {
      try {
        activeJob = job;
        await reconcileHolds(store, archive);
        if (job.payload.kind === "evidence-export")
          await require("./server/evidence.cjs").processEvidence(
            store,
            archive,
            job,
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
