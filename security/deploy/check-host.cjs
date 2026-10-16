"use strict";
// Read-only inventory. No network requests, credentials, hostnames or settings changes.
const fs = require("node:fs"),
  os = require("node:os");
const { spawnSync } = require("node:child_process");
function command(bin, args) {
  try {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
    return r.status === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}
function collect(dataPath) {
  let freeBytes = null,
    sqlite = false,
    memoryBytes = null,
    cpuCount = null;
  try {
    memoryBytes = os.totalmem();
    cpuCount = os.cpus().length;
  } catch {}
  try {
    const s = fs.statfsSync(dataPath);
    freeBytes = s.bavail * s.bsize;
  } catch {}
  try {
    const { DatabaseSync, backup } = require("node:sqlite");
    const d = new DatabaseSync(":memory:");
    d.close();
    sqlite = typeof backup === "function";
  } catch {}
  let dependencies = true;
  for (const name of ["@aws-sdk/client-s3", "openid-client"])
    try {
      require.resolve(name);
    } catch {
      dependencies = false;
    }
  const power =
    process.platform === "darwin"
      ? command("/usr/bin/pmset", ["-g", "custom"])
      : "";
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    memoryBytes,
    cpuCount,
    freeBytes,
    sqlite,
    dependencies,
    ffprobe: /^ffprobe version /m.test(command("ffprobe", ["-version"])),
    h264Encoder: /\blibx264\b/.test(
      command("ffmpeg", ["-hide_banner", "-encoders"]),
    ),
    sleepMinutes: /^\s*sleep\s+(\d+)\s*$/m.exec(power)?.[1] ?? null,
    restartAfterPowerLoss:
      /^\s*autorestart\s+(\d+)\s*$/m.exec(power)?.[1] ?? null,
  };
}
function assess(f) {
  const [major, minor] = f.node.split(".").map(Number);
  const checks = {
    supportedPlatform: ["darwin", "linux"].includes(f.platform),
    node: major > 22 || (major === 22 && minor >= 16),
    sqlite: f.sqlite,
    dependencies: f.dependencies,
    memoryAtLeast8GB: f.memoryBytes >= 8e9,
    freeSpaceAtLeast200GB: f.freeBytes !== null && f.freeBytes >= 200e9,
    ffprobe: f.ffprobe,
    h264Encoder: f.h264Encoder,
    ...(f.platform === "darwin"
      ? {
          automaticSleepDisabled: f.sleepMinutes === "0",
          powerRestartConfigured: f.restartAfterPowerLoss === "1",
        }
      : {}),
  };
  return {
    purpose: "bounded staging host screening; not production commissioning",
    facts: f,
    checks,
    screeningPassed: Object.values(checks).every(Boolean),
    productionReady: false,
    manualGates: [
      "Confirm this is the Southampton host",
      "Dedicated account and persistent encrypted local filesystem",
      "Wired internet, measured upload capacity and UPS for Mac/router/cameras",
      "Cold boot and FileVault recovery observed on this exact Mac",
      "Independent archive, backups, identity and external alert delivery tested",
      "Bounded pilot and local capacity plan; staging files are not automatically evicted",
    ],
  };
}
if (require.main === module) {
  const result = assess(collect(process.argv[2] || process.cwd()));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.screeningPassed ? 0 : 2;
}
module.exports = { collect, assess };
