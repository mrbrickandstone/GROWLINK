"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const {
  readConfig: readBackupConfig,
  privateFile,
  privateDirectory,
  createBackup,
  readCheckpoint,
} = require("./backup.cjs");
const { DiskGuard } = require("./capacity.cjs");
const MINUTE = 60000;
function fail(code) {
  throw Error(code);
}
function configurationId(c) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        dataDir: c.backup.dataDir,
        repository: c.backup.repository,
        resticBinary: c.backup.resticBinary,
        passwordFile: c.backup.passwordFile,
      }),
    )
    .digest("hex");
}
function readJson(file) {
  privateFile(file, 32768);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function sync(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function save(file, value) {
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  sync(path.dirname(file));
}
function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
function loadState(root) {
  const file = path.join(root, "status.json");
  if (!exists(file))
    return {
      schema: "farber-backup-schedule-v1",
      lastSuccess: null,
      lastRun: null,
    };
  const state = readJson(file);
  if (state.schema !== "farber-backup-schedule-v1")
    fail("BACKUP_SCHEDULE_STATE_INVALID");
  return state;
}
function readConfig(file) {
  try {
    const c = readJson(file),
      allowed = [
        "backupConfigFile",
        "stateDir",
        "intervalMinutes",
        "minimumFreeBytes",
        "maxRunMinutes",
      ];
    if (!c || Object.keys(c).some((k) => !allowed.includes(k))) throw Error();
    for (const k of ["backupConfigFile", "stateDir"])
      if (typeof c[k] !== "string" || !path.isAbsolute(c[k])) throw Error();
    if (
      !Number.isSafeInteger(c.intervalMinutes) ||
      c.intervalMinutes < 15 ||
      c.intervalMinutes > 1440
    )
      throw Error();
    if (
      !Number.isSafeInteger(c.maxRunMinutes) ||
      c.maxRunMinutes < 1 ||
      c.maxRunMinutes > 60
    )
      throw Error();
    if (
      !Number.isSafeInteger(c.minimumFreeBytes) ||
      c.minimumFreeBytes < 1e9 ||
      c.minimumFreeBytes > 1e15
    )
      throw Error();
    c.stateDir = privateDirectory(c.stateDir);
    return { ...c, backup: readBackupConfig(c.backupConfigFile) };
  } catch {
    fail("PRIVATE_BACKUP_SCHEDULE_CONFIG_INVALID");
  }
}
function folders(c) {
  privateDirectory(c.stateDir);
  for (const name of ["checkpoints", "runs"]) {
    const dir = path.join(c.stateDir, name);
    if (!exists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    privateDirectory(dir);
  }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
function capacity(c, statfs) {
  const paths = [
    ...new Set([c.backup.dataDir, c.backup.stagingParent, c.stateDir]),
  ];
  const guards = paths.map(
    (dir) =>
      new DiskGuard(dir, {
        env: { SECURITY_MIN_FREE_BYTES: String(c.minimumFreeBytes) },
        ...(statfs ? { statfs } : {}),
      }),
  );
  let bytes = 0;
  for (const name of ["command.sqlite", "command.sqlite-wal"]) {
    const file = path.join(c.backup.dataDir, name);
    try {
      bytes += privateFile(file).size;
    } catch (e) {
      if (e.code !== "ENOENT" || name === "command.sqlite") throw e;
    }
  }
  // Two plaintext copies, growth margin and temporary restic buffers; the
  // ongoing check still stops writes if other processes consume this margin.
  const headroom = bytes * 4 + 512 * 1024 * 1024;
  if (!Number.isSafeInteger(headroom)) fail("BACKUP_CAPACITY_UNKNOWN");
  return (admission = false) => {
    for (const guard of guards) guard.assertSpace(admission ? headroom : 0);
  };
}
function safeFailure(e) {
  if (e?.message === "DISK_SPACE_LOW" || e?.code === "ENOSPC")
    return "BACKUP_DISK_SPACE_LOW";
  if (e?.message === "DISK_CAPACITY_UNKNOWN") return "BACKUP_CAPACITY_UNKNOWN";
  if (["BACKUP_CANCELLED", "BACKUP_RUN_TIMEOUT"].includes(e?.message))
    return e.message;
  return "BACKUP_RUN_FAILED";
}
async function run(c, options = {}) {
  folders(c);
  const now = options.now || Date.now,
    lock = path.join(c.stateDir, "active"),
    statusFile = path.join(c.stateDir, "status.json");
  // Atomic directory creation prevents overlapping manual/scheduled invocations.
  // Never remove an existing lock just because a lease or timeout elapsed.
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST")
      return { state: "locked", code: "BACKUP_RECONCILIATION_REQUIRED" };
    throw e;
  }
  sync(c.stateDir);
  let state, record, controller, monitor, deadline, interruption;
  try {
    state = loadState(c.stateDir);
    const configId = configurationId(c);
    if (state.configurationId !== configId) {
      if (state.configurationId)
        save(path.join(c.stateDir, "runs", crypto.randomUUID() + ".json"), {
          state: "configuration-changed",
          prior: state,
          at: now(),
        });
      state = {
        schema: "farber-backup-schedule-v1",
        configurationId: configId,
        lastSuccess: null,
        lastRun: null,
      };
    }
    state.lastSchedulerAt = now();
    if (
      (Number.isSafeInteger(state.nextAttemptAt) &&
        state.nextAttemptAt > now()) ||
      (state.lastSuccess &&
        Number.isSafeInteger(state.lastSuccess.createdAt) &&
        state.lastSuccess.createdAt <= now() &&
        now() < state.lastSuccess.createdAt + c.intervalMinutes * MINUTE &&
        state.lastRun?.state === "complete")
    ) {
      save(statusFile, state);
      fs.rmdirSync(lock);
      sync(c.stateDir);
      return { state: "not-due" };
    }
    const id = crypto.randomUUID();
    record = {
      id,
      state: "running",
      startedAt: now(),
      pid: process.pid,
      childPid: null,
      phase: "preparing",
      checkpoint: id + ".json",
      maxRunMinutes: c.maxRunMinutes,
      configurationId: configId,
    };
    save(path.join(lock, "run.json"), record);
    state.lastRun = record;
    save(statusFile, state);
    controller = new AbortController();
    const cancel = (e) => {
      interruption ||= e;
      controller.abort();
    };
    const externalAbort = () => cancel(Error("BACKUP_CANCELLED"));
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    try {
      const assertSpace = capacity(c, options.statfs);
      assertSpace(true);
      const check = () => {
        controller.signal.throwIfAborted();
        assertSpace();
      };
      monitor = setInterval(() => {
        try {
          check();
        } catch (e) {
          cancel(e);
        }
      }, 2000);
      deadline = setTimeout(
        () => cancel(Error("BACKUP_RUN_TIMEOUT")),
        c.maxRunMinutes * MINUTE,
      );
      monitor.unref();
      deadline.unref();
      const checkpoint = await (options.createBackup || createBackup)(
        c.backup,
        path.join(c.stateDir, "checkpoints", record.checkpoint),
        {
          signal: controller.signal,
          assertSpace: check,
          onChild(pid) {
            record.childPid = pid;
            record.phase = pid ? "restic" : "verifying";
            save(path.join(lock, "run.json"), record);
          },
        },
      );
      // Require the persisted receipt, not a child's exit status or a fabricated return value.
      const persisted = readCheckpoint(
        path.join(c.stateDir, "checkpoints", record.checkpoint),
      );
      if (JSON.stringify(persisted) !== JSON.stringify(checkpoint))
        fail("BACKUP_CHECKPOINT_MISMATCH");
      const createdAt = Date.parse(checkpoint.createdAt);
      if (
        !Number.isSafeInteger(createdAt) ||
        createdAt < record.startedAt ||
        createdAt > now()
      )
        fail("BACKUP_CHECKPOINT_TIME_INVALID");
      record.state = "complete";
      record.finishedAt = now();
      record.phase = "complete";
      record.childPid = null;
      state.lastSuccess = {
        createdAt,
        verifiedAt: now(),
        checkpoint: record.checkpoint,
        snapshotId: checkpoint.snapshotId,
        manifestSha256: checkpoint.manifestSha256,
        independentLocationVerified: false,
      };
      state.failureCode = null;
      state.consecutiveFailures = 0;
      state.nextAttemptAt = 0;
    } catch (e) {
      record.state = "failed";
      record.finishedAt = now();
      record.code = safeFailure(interruption || e);
      record.childPid = null;
      state.failureCode = record.code;
      state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
      state.nextAttemptAt =
        now() +
        Math.min(60, 5 * 2 ** Math.min(state.consecutiveFailures - 1, 4)) *
          MINUTE;
    } finally {
      options.signal?.removeEventListener("abort", externalAbort);
    }
    state.lastRun = record;
    save(path.join(c.stateDir, "runs", record.id + ".json"), record);
    save(statusFile, state);
    fs.unlinkSync(path.join(lock, "run.json"));
    fs.rmdirSync(lock);
    sync(c.stateDir);
    return {
      state: record.state,
      code: record.code || null,
      restoreVerified: record.state === "complete",
      independentLocationVerified: false,
    };
  } finally {
    clearInterval(monitor);
    clearTimeout(deadline);
  }
}
function reconcile(c, { processesStopped, reference } = {}) {
  if (
    processesStopped !== true ||
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 500
  )
    fail("BACKUP_RECONCILIATION_ATTESTATION_REQUIRED");
  folders(c);
  const lock = path.join(c.stateDir, "active");
  privateDirectory(lock);
  let record;
  try {
    record = readJson(path.join(lock, "run.json"));
  } catch {
    record = null;
  }
  if (record && record.configurationId !== configurationId(c))
    fail("BACKUP_CONFIGURATION_CHANGED_REVIEW_REQUIRED");
  if (record && (alive(record.pid) || alive(record.childPid)))
    fail("BACKUP_PROCESS_STILL_RUNNING");
  // An explicit administrator check is required even when recorded PIDs vanished:
  // a crash between spawn and PID persistence could leave an unrecorded child.
  const state = loadState(c.stateDir),
    now = Date.now();
  let recovered = false;
  if (record && /^[a-f0-9-]{36}\.json$/.test(record.checkpoint || "")) {
    try {
      const checkpoint = readCheckpoint(
        path.join(c.stateDir, "checkpoints", record.checkpoint),
      );
      const createdAt = Date.parse(checkpoint.createdAt);
      if (
        !Number.isSafeInteger(createdAt) ||
        createdAt < record.startedAt ||
        createdAt > now
      )
        throw Error();
      state.lastSuccess = {
        createdAt,
        verifiedAt: now,
        checkpoint: record.checkpoint,
        snapshotId: checkpoint.snapshotId,
        manifestSha256: checkpoint.manifestSha256,
        independentLocationVerified: false,
      };
      recovered = true;
    } catch {}
  }
  const id = crypto.randomUUID(),
    report = {
      id,
      state: recovered ? "complete" : "failed",
      code: recovered ? null : "BACKUP_INTERRUPTED",
      startedAt: record?.startedAt || now,
      finishedAt: now,
      reconciledAt: now,
      reference: reference.trim(),
      priorRun: record,
      independentLocationVerified: false,
    };
  save(path.join(c.stateDir, "runs", id + ".json"), report);
  state.lastRun = report;
  state.failureCode = recovered ? null : "BACKUP_INTERRUPTED";
  state.nextAttemptAt = 0;
  save(path.join(c.stateDir, "status.json"), state);
  // Preserve the entire uncertain run directory instead of deleting partial files.
  fs.renameSync(lock, path.join(c.stateDir, "runs", id + ".interrupted"));
  sync(c.stateDir);
  return {
    reconciled: true,
    recoveredCheckpoint: recovered,
    independentLocationVerified: false,
  };
}
function observe(env, now = Date.now()) {
  if (!env.SECURITY_BACKUP_STATE_DIR)
    return {
      state: "unconfigured",
      faultCodes: [],
      independentLocationVerified: false,
    };
  try {
    const root = privateDirectory(env.SECURITY_BACKUP_STATE_DIR),
      state = loadState(root),
      age = Number(env.SECURITY_BACKUP_MAX_AGE_MINUTES || "120");
    if (!Number.isSafeInteger(age) || age < 15 || age > 2880) throw Error();
    const codes = [],
      last = state.lastSuccess,
      active = exists(path.join(root, "active"));
    if (
      !Number.isSafeInteger(state.lastSchedulerAt) ||
      state.lastSchedulerAt > now ||
      now - state.lastSchedulerAt > 180000
    ) {
      if (!active) codes.push("BACKUP_SCHEDULER_MISSING");
    }
    if (active) {
      let r;
      try {
        r = readJson(path.join(root, "active", "run.json"));
      } catch {}
      if (
        !r ||
        !alive(r.pid) ||
        !Number.isSafeInteger(r.startedAt) ||
        r.startedAt > now ||
        !Number.isSafeInteger(r.maxRunMinutes) ||
        r.maxRunMinutes < 1 ||
        r.maxRunMinutes > 60 ||
        now - r.startedAt > r.maxRunMinutes * MINUTE + 30000
      )
        codes.push("BACKUP_RECONCILIATION_REQUIRED");
    }
    if (!active && state.lastRun?.state === "running")
      codes.push("BACKUP_RECONCILIATION_REQUIRED");
    if (last) {
      if (
        !Number.isSafeInteger(last.verifiedAt) ||
        last.verifiedAt < last.createdAt ||
        last.verifiedAt > now
      )
        throw Error();
      if (!/^[a-f0-9-]{36}\.json$/.test(last.checkpoint || "")) throw Error();
      const cp = readCheckpoint(
        path.join(root, "checkpoints", last.checkpoint),
      );
      if (
        cp.snapshotId !== last.snapshotId ||
        cp.manifestSha256 !== last.manifestSha256 ||
        Date.parse(cp.createdAt) !== last.createdAt
      )
        throw Error();
    }
    if (
      !last ||
      !Number.isSafeInteger(last.createdAt) ||
      last.createdAt > now ||
      now - last.createdAt > age * MINUTE
    )
      codes.push("BACKUP_STALE");
    if (state.failureCode || state.lastRun?.state === "failed")
      codes.push("BACKUP_RUN_FAILED");
    return {
      state: codes.length ? "failed" : active ? "running" : "verified",
      faultCodes: codes,
      lastSnapshotAt: last?.createdAt || null,
      lastVerifiedAt: last?.verifiedAt || null,
      maxAgeMinutes: age,
      independentLocationVerified: false,
    };
  } catch {
    return {
      state: "unknown",
      faultCodes: ["BACKUP_STATUS_UNAVAILABLE"],
      independentLocationVerified: false,
    };
  }
}
module.exports = { readConfig, run, reconcile, observe };
