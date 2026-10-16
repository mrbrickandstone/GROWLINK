"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assess } = require("../../security/deploy/check-host.cjs");
const { readConfig } = require("../../security/deploy/run-service.cjs");
const { include } = require("../../security/deploy/release.cjs");
test("host screening rejects sleep, unknown recovery, missing dependencies and insufficient disk", () => {
  const f = {
    platform: "darwin",
    node: "22.13.0",
    memoryBytes: 16e9,
    freeBytes: 250e9,
    sqlite: true,
    dependencies: true,
    ffprobe: true,
    h264Encoder: true,
    sleepMinutes: "0",
    restartAfterPowerLoss: "1",
  };
  assert.equal(assess(f).screeningPassed, true);
  assert.equal(assess(f).productionReady, false);
  for (const patch of [
    { sleepMinutes: "1" },
    { restartAfterPowerLoss: null },
    { freeBytes: 37e9 },
    { freeBytes: null },
    { dependencies: false },
    { node: "22.12.0" },
    { memoryBytes: null },
  ])
    assert.equal(assess({ ...f, ...patch }).screeningPassed, false);
});
test("service configuration is private, role-scoped, literal and never included in errors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "worker.json"),
    link = path.join(root, "link.json");
  const sentinel = "test-only-credential-$(touch SHOULD_NOT_EXIST)";
  const good = { SECURITY_DATA_DIR: root, RING_CLIENT_SECRET: sentinel };
  fs.writeFileSync(file, JSON.stringify(good), { mode: 0o600 });
  assert.equal(readConfig("worker", file).RING_CLIENT_SECRET, sentinel);
  assert.throws(
    () => readConfig("web", file),
    /PRIVATE_SERVICE_CONFIG_INVALID/,
  );
  fs.symlinkSync(file, link);
  assert.throws(
    () => readConfig("worker", link),
    /PRIVATE_SERVICE_CONFIG_INVALID/,
  );
  fs.chmodSync(file, 0o644);
  assert.throws(
    () => readConfig("worker", file),
    /PRIVATE_SERVICE_CONFIG_INVALID/,
  );
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ ...good, NODE_OPTIONS: sentinel }));
  assert.throws(
    () => readConfig("worker", file),
    /PRIVATE_SERVICE_CONFIG_INVALID/,
  );
  const run = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../security/deploy/run-service.cjs"),
      "worker",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr.trim(), "PRIVATE_SERVICE_CONFIG_INVALID");
  assert.equal(fs.existsSync(path.join(root, "SHOULD_NOT_EXIST")), false);
});
test("release allowlist excludes state, footage, real service configs and developer dependencies", () => {
  for (const p of [
    ".env",
    ".pilot/media-smoke/original.mp4",
    ".security/command.sqlite",
    "security/.env",
    "security/deploy/worker.json",
    "security/deploy/web.json",
    "security/node_modules/x/index.js",
    "security/public/photo.jpg",
    "security/deploy/secret.key",
    "security/deploy/../.env",
    "security/deploy/config/worker.example.json",
  ])
    assert.equal(include(p), false, p);
  for (const p of [
    "security/deploy/worker.example.json",
    "security/deploy/com.farber.security.worker.plist",
    "security/deploy/run-service.cjs",
    "security/package-lock.json",
    "security/public/app.js",
    "lib/security/ring-pilot.cjs",
    "docs/security/PILOT_REPORT.md",
  ])
    assert.equal(include(p), true, p);
});
test("fresh-host initialization preserves room mapping without enabling Ring or overwriting existing cameras", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../security/cli.cjs"), "init-site"],
      {
        env: { PATH: process.env.PATH, SECURITY_DATA_DIR: root },
        encoding: "utf8",
      },
    );
  assert.equal(run().status, 0);
  const { Store } = require("../../security/server/store.cjs");
  const store = new Store(root);
  try {
    const cameras = store.all("cameras");
    assert.equal(cameras.length, 3);
    assert.equal(store.get("cameras", "ring-1").room, "FLOWERING");
    assert.equal(store.get("cameras", "ring-2").room, "FRONT DOOR");
    assert.ok(
      cameras.every(
        (c) => c.exportEnabled === false && c.sourceQualified === false,
      ),
    );
    assert.equal(store.get("policy", "ring"), null);
    const camera = store.get("cameras", "ring-1");
    store.put("cameras", camera.id, { ...camera, room: "Existing room" });
    assert.equal(run().status, 0);
    assert.equal(store.get("cameras", camera.id).room, "Existing room");
  } finally {
    store.close();
  }
});
