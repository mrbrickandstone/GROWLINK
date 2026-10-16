"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawn, spawnSync } = require("node:child_process"),
  { once } = require("node:events");
const { Store } = require("../../security/server/store.cjs"),
  { Watchdog } = require("../../security/server/watchdog.cjs");
const {
  readConfig,
  run,
  reconcile,
  observe,
} = require("../../security/server/backup-scheduler.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "farber-backup-schedule-"),
    ),
    dataDir = path.join(root, "data"),
    store = new Store(dataDir),
    stateDir = path.join(root, "state"),
    stagingParent = path.join(root, "staging"),
    passwordFile = path.join(root, "password");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(stagingParent, { mode: 0o700 });
  fs.writeFileSync(passwordFile, "synthetic-only", { mode: 0o600 });
  const c = {
    stateDir,
    intervalMinutes: 60,
    minimumFreeBytes: 1e9,
    maxRunMinutes: 15,
    backup: {
      dataDir,
      stagingParent,
      resticBinary: process.execPath,
      passwordFile,
      repository: path.join(root, "repo"),
    },
  };
  const backupConfigFile = path.join(root, "backup.json"),
    configFile = path.join(root, "schedule.json");
  fs.writeFileSync(backupConfigFile, JSON.stringify(c.backup), { mode: 0o600 });
  const config = { ...c, backupConfigFile };
  delete config.backup;
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    c,
    config,
    configFile,
    backupConfigFile,
    env: {
      SECURITY_BACKUP_STATE_DIR: stateDir,
      SECURITY_BACKUP_MAX_AGE_MINUTES: "120",
    },
  };
}
const ample = () => ({ bavail: 100000000, bsize: 4096 });
function success(now = Date.now) {
  return async (_, file) => {
    const cp = {
      schema: "farber-backup-checkpoint-v1",
      snapshotId: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      createdAt: new Date(now()).toISOString(),
      restoreVerified: true,
      independentLocationVerified: false,
    };
    fs.writeFileSync(file, JSON.stringify(cp), { mode: 0o600 });
    return cp;
  };
}
test("private schedule config and published service templates reject unsafe settings without leaking credentials", (t) => {
  const f = fixture(t);
  assert.equal(readConfig(f.configFile).intervalMinutes, 60);
  for (const change of [
    { intervalMinutes: 0 },
    { intervalMinutes: 1441 },
    { maxRunMinutes: 0 },
    { minimumFreeBytes: 10 },
    { TOKEN: "SENTINEL" },
  ]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, ...change }));
    assert.throws(
      () => readConfig(f.configFile),
      /^Error: PRIVATE_BACKUP_SCHEDULE_CONFIG_INVALID$/,
    );
  }
  fs.writeFileSync(f.configFile, JSON.stringify(f.config));
  fs.chmodSync(f.configFile, 0o644);
  assert.throws(
    () => readConfig(f.configFile),
    /PRIVATE_BACKUP_SCHEDULE_CONFIG_INVALID/,
  );
  fs.chmodSync(f.configFile, 0o600);
  fs.symlinkSync(f.configFile, path.join(f.root, "link"));
  assert.throws(
    () => readConfig(path.join(f.root, "link")),
    /PRIVATE_BACKUP_SCHEDULE_CONFIG_INVALID/,
  );
  const { include } = require("../../security/deploy/release.cjs");
  for (const p of [
    "security/backup-schedule.cjs",
    "security/server/backup-scheduler.cjs",
    "security/deploy/farber-backup.timer",
    "security/deploy/com.farber.security.backup.plist",
  ])
    assert.equal(include(p), true);
  assert.equal(include("security/deploy/backup-schedule.json"), false);
});
test("scheduled success requires a saved verified checkpoint, persists cadence across restart, and detects changed destination", async (t) => {
  const f = fixture(t);
  let clock = Date.now(),
    calls = 0;
  const opts = {
    now: () => clock,
    statfs: ample,
    createBackup: async (...args) => {
      calls++;
      return success(() => clock)(...args);
    },
  };
  assert.equal((await run(f.c, opts)).state, "complete");
  assert.equal(calls, 1);
  assert.equal(observe(f.env, clock).state, "verified");
  assert.equal(observe(f.env, clock).independentLocationVerified, false);
  assert.equal((await run(readConfig(f.configFile), opts)).state, "not-due");
  clock += 3600000;
  assert.equal((await run(f.c, opts)).state, "complete");
  assert.equal(calls, 2);
  const changed = {
    ...f.c,
    backup: { ...f.c.backup, repository: path.join(f.root, "new-repo") },
  };
  assert.equal((await run(changed, opts)).state, "complete");
  assert.equal(calls, 3);
  assert.equal(
    fs.readdirSync(path.join(f.c.stateDir, "checkpoints")).length,
    3,
  );
  assert.equal(fs.existsSync(path.join(f.c.stateDir, "active")), false);
  assert.equal(
    fs.statSync(path.join(f.c.stateDir, "status.json")).mode & 0o077,
    0,
  );
});
test("overlapping schedules are refused and live processes cannot be reconciled", async (t) => {
  const f = fixture(t);
  let release, entered;
  const ready = new Promise((r) => {
      entered = r;
    }),
    hold = new Promise((r) => {
      release = r;
    });
  const work = run(f.c, {
    statfs: ample,
    createBackup: async (...args) => {
      entered();
      await hold;
      return success()(...args);
    },
  });
  await ready;
  assert.equal((await run(f.c, { statfs: ample })).state, "locked");
  assert.throws(
    () => reconcile(f.c, { processesStopped: true, reference: "TEST" }),
    /PROCESS_STILL_RUNNING/,
  );
  release();
  assert.equal((await work).state, "complete");
});
test("low or unknown capacity prevents all backup work and failures back off durably", async (t) => {
  const f = fixture(t);
  let clock = Date.now(),
    calls = 0;
  const opts = {
    now: () => clock,
    createBackup: async () => {
      calls++;
    },
  };
  const first = await run(f.c, {
    ...opts,
    statfs: () => ({ bavail: 1, bsize: 4096 }),
  });
  assert.equal(first.code, "BACKUP_DISK_SPACE_LOW");
  assert.equal(calls, 0);
  assert.equal((await run(f.c, { ...opts, statfs: ample })).state, "not-due");
  assert.ok(observe(f.env, clock).faultCodes.includes("BACKUP_RUN_FAILED"));
  clock += 5 * 60000;
  assert.equal(
    (
      await run(f.c, {
        ...opts,
        statfs() {
          throw Error("private path");
        },
      })
    ).code,
    "BACKUP_CAPACITY_UNKNOWN",
  );
  assert.equal(calls, 0);
});
test("a missing checkpoint and abort after admission cannot be reported as successful", async (t) => {
  const f = fixture(t);
  const result = await run(f.c, {
    statfs: ample,
    createBackup: async () => ({ restoreVerified: true }),
  });
  assert.equal(result.state, "failed");
  assert.equal(observe(f.env).state, "failed");
  const g = fixture(t),
    controller = new AbortController();
  let called = false;
  const outcome = await run(g.c, {
    statfs: ample,
    signal: controller.signal,
    createBackup: async (_, file, options) => {
      called = true;
      controller.abort();
      options.signal.throwIfAborted();
    },
  });
  assert.equal(called, true);
  assert.equal(outcome.code, "BACKUP_CANCELLED");
  assert.equal(fs.existsSync(path.join(g.c.stateDir, "active")), false);
});
test("missing scheduler, stale snapshots, changed receipts and failed runs reach independent watchdog incidents", async (t) => {
  const f = fixture(t);
  let clock = Date.now();
  await run(f.c, {
    now: () => clock,
    statfs: ample,
    createBackup: success(() => clock),
  });
  assert.ok(
    observe(f.env, clock + 180001).faultCodes.includes(
      "BACKUP_SCHEDULER_MISSING",
    ),
  );
  const stale = observe(f.env, clock + 121 * 60000);
  assert.ok(stale.faultCodes.includes("BACKUP_STALE"));
  const dogStore = new Store(path.join(f.root, "dog"), {
    now: () => clock + 121 * 60000,
  });
  t.after(() => dogStore.close());
  const sent = [],
    dog = new Watchdog(dogStore, {
      notify: async (p) => {
        sent.push(p);
        return { accepted: true };
      },
    });
  dog.heartbeat("archive-worker", "failed", stale.faultCodes);
  await dog.tick();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].faultCodes.includes("BACKUP_STALE"));
  assert.equal(dogStore.all("incidents")[0].recipientReceivedAt, null);
  const state = JSON.parse(
    fs.readFileSync(path.join(f.c.stateDir, "status.json")),
  );
  fs.unlinkSync(
    path.join(f.c.stateDir, "checkpoints", state.lastSuccess.checkpoint),
  );
  assert.deepEqual(observe(f.env).faultCodes, ["BACKUP_STATUS_UNAVAILABLE"]);
  assert.equal(observe({}).state, "unconfigured");
});
test("actual scheduler SIGKILL preserves the uncertain lock and requires explicit stopped-process reconciliation", async (t) => {
  const f = fixture(t),
    modulePath = path.resolve(
      __dirname,
      "../../security/server/backup-scheduler.cjs",
    );
  const script = `const a=require(process.argv[1]), c=a.readConfig(process.argv[2]);
    a.run(c,{statfs:()=>({bavail:100000000,bsize:4096}),createBackup:async()=>{process.stdout.write('READY\\n');await new Promise(()=>{});}});
    setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ["-e", script, modulePath, f.configFile],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal((await run(f.c, { statfs: ample })).state, "locked");
  assert.ok(
    observe(f.env).faultCodes.includes("BACKUP_RECONCILIATION_REQUIRED"),
  );
  assert.throws(() => reconcile(f.c), /ATTESTATION/);
  assert.equal(
    reconcile(f.c, { processesStopped: true, reference: "SYNTHETIC-STOPPED" })
      .recoveredCheckpoint,
    false,
  );
  assert.ok(
    fs
      .readdirSync(path.join(f.c.stateDir, "runs"))
      .some((p) => p.endsWith(".interrupted")),
  );
  assert.equal(
    (await run(f.c, { statfs: ample, createBackup: success() })).state,
    "complete",
  );
});
test("an interrupted run with a completed checkpoint reconciles without repeating provider work", async (t) => {
  const f = fixture(t),
    modulePath = path.resolve(
      __dirname,
      "../../security/server/backup-scheduler.cjs",
    );
  const script = `const a=require(process.argv[1]),fs=require('node:fs'),c=a.readConfig(process.argv[2]);
    a.run(c,{statfs:()=>({bavail:100000000,bsize:4096}),createBackup:async(_,file)=>{
      const cp={schema:'farber-backup-checkpoint-v1',snapshotId:'a'.repeat(64),manifestSha256:'b'.repeat(64),createdAt:new Date().toISOString(),restoreVerified:true};
      fs.writeFileSync(file,JSON.stringify(cp),{mode:0o600}); process.kill(process.pid,'SIGKILL'); }});`;
  const killed = spawnSync(
    process.execPath,
    ["-e", script, modulePath, f.configFile],
    { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(killed.signal, "SIGKILL");
  const result = reconcile(f.c, {
    processesStopped: true,
    reference: "CHECKPOINT-REVIEW",
  });
  assert.equal(result.recoveredCheckpoint, true);
  assert.equal(
    (
      await run(f.c, {
        statfs: ample,
        createBackup() {
          throw Error("must not run");
        },
      })
    ).state,
    "not-due",
  );
});
test("actual archive worker reports backup faults without starting backups or exposing private paths", async (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: process.env.PATH,
        SECURITY_DATA_DIR: f.c.backup.dataDir,
        ...f.env,
        SECURITY_MIN_FREE_BYTES: "1000000000",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const beat = f.store.get("heartbeats", "archive-worker");
  assert.ok(beat.faultCodes.includes("BACKUP_STALE"));
  assert.ok(beat.faultCodes.includes("BACKUP_SCHEDULER_MISSING"));
  assert.equal(beat.backup.independentLocationVerified, false);
  assert.equal(JSON.stringify(beat).includes(f.root), false);
  assert.equal(fs.existsSync(path.join(f.c.stateDir, "checkpoints")), false);
});
test("cancelling an actual backup child waits for its exit and leaves no false checkpoint", async (t) => {
  const f = fixture(t),
    executable = path.join(f.root, "restic-wait-fixture"),
    controller = new AbortController();
  fs.writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n", {
    mode: 0o700,
  });
  const { createBackup } = require("../../security/server/backup.cjs");
  const checkpoint = path.join(f.root, "never-complete.json");
  let pid,
    observedExit = false;
  await assert.rejects(
    createBackup({ ...f.c.backup, resticBinary: executable }, checkpoint, {
      signal: controller.signal,
      onChild(value) {
        if (value) {
          pid = value;
          setTimeout(() => controller.abort(), 20);
        } else if (pid) {
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
          observedExit = true;
        }
      },
    }),
    /RESTIC_OPERATION_FAILED/,
  );
  assert.equal(observedExit, true);
  assert.equal(fs.existsSync(checkpoint), false);
  assert.equal(fs.readdirSync(f.c.backup.stagingParent).length, 0);
});
test("capacity loss during a real backup subprocess stops it and reports failure without a checkpoint", async (t) => {
  const f = fixture(t),
    executable = path.join(f.root, "restic-pressure-fixture"),
    { createBackup } = require("../../security/server/backup.cjs");
  fs.writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  let pressure = false,
    pid;
  const result = await run(
    { ...f.c, backup: { ...f.c.backup, resticBinary: executable } },
    {
      statfs: () => (pressure ? { bavail: 1, bsize: 4096 } : ample()),
      createBackup: (config, file, options) =>
        createBackup(config, file, {
          ...options,
          onChild(value) {
            options.onChild(value);
            if (value) {
              pid = value;
              pressure = true;
            }
          },
        }),
    },
  );
  assert.equal(result.code, "BACKUP_DISK_SPACE_LOW");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(
    fs.readdirSync(path.join(f.c.stateDir, "checkpoints")).length,
    0,
  );
  assert.equal(fs.existsSync(path.join(f.c.stateDir, "active")), false);
});
