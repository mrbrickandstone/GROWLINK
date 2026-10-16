"use strict";
// launchd has no EnvironmentFile. Read a private JSON file without a shell.
const fs = require("node:fs"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const shared = [
  "SECURITY_DATA_DIR",
  "SECURITY_S3_BUCKET",
  "SECURITY_S3_REGION",
  "SECURITY_S3_ENDPOINT",
  "SECURITY_S3_PATH_STYLE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];
const allowed = {
  web: [
    ...shared,
    "SECURITY_HOST",
    "SECURITY_PORT",
    "SECURITY_ORIGIN",
    "SECURITY_HEALTH_TOKEN",
    "SECURITY_OIDC_ISSUER",
    "SECURITY_OIDC_CLIENT_ID",
    "SECURITY_OIDC_CLIENT_SECRET",
    "SECURITY_OIDC_ACR",
  ],
  worker: [
    ...shared,
    "SECURITY_STORAGE_LOCK_APPROVED",
    "SECURITY_ENABLE_PHYSICAL_DELETION",
    "SECURITY_MIN_FREE_BYTES",
    "SECURITY_ENABLE_CACHE_EVICTION",
    "SECURITY_CACHE_KEEP_HOURS",
    "SECURITY_ARCHIVE_VERIFY_HOURS",
    "RING_CLIENT_ID",
    "RING_CLIENT_SECRET",
    "RING_HMAC_KEY",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "SECURITY_WATCHDOG_URL",
    "SECURITY_WATCHDOG_TOKEN",
  ],
  watchdog: [
    "SECURITY_WATCHDOG_DIR",
    "SECURITY_WATCHDOG_HOST",
    "SECURITY_WATCHDOG_PORT",
    "SECURITY_EXPECTED_COMPONENTS",
    "SECURITY_WATCHDOG_TOKEN",
    "SECURITY_ALERT_WEBHOOK",
    "SECURITY_ALERT_TOKEN",
    "SECURITY_CONTROL_HEALTH_URL",
    "SECURITY_CONTROL_HEALTH_TOKEN",
    "SECURITY_DEADMAN_URL",
    "SECURITY_DEADMAN_TOKEN",
  ],
};
function readConfig(role, file) {
  if (!Object.hasOwn(allowed, role)) throw Error("SERVICE_ROLE_INVALID");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    if (
      !s.isFile() ||
      s.size > 32768 ||
      s.mode & 0o077 ||
      ![0, process.getuid()].includes(s.uid)
    )
      throw Error();
    const raw = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!raw || Array.isArray(raw) || typeof raw !== "object") throw Error();
    const result = Object.create(null);
    for (const [k, v] of Object.entries(raw)) {
      if (
        !allowed[role].includes(k) ||
        typeof v !== "string" ||
        v.includes("\0")
      )
        throw Error();
      if (v) result[k] = v;
    }
    const dataKey =
      role === "watchdog" ? "SECURITY_WATCHDOG_DIR" : "SECURITY_DATA_DIR";
    if (!result[dataKey] || !path.isAbsolute(result[dataKey])) throw Error();
    return result;
  } catch {
    throw Error("PRIVATE_SERVICE_CONFIG_INVALID");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function launch(role, file) {
  process.umask(0o077);
  const config = readConfig(role, file);
  const entry = {
    web: "server.cjs",
    worker: "worker.cjs",
    watchdog: "watchdog.cjs",
  }[role];
  const child = spawn(process.execPath, [path.join(__dirname, "..", entry)], {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
    env: {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TZ: "UTC",
      AWS_EC2_METADATA_DISABLED: "true",
      ...config,
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    console.error("SERVICE_START_FAILED");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
if (require.main === module) {
  try {
    launch(...process.argv.slice(2));
  } catch (e) {
    console.error(
      ["SERVICE_ROLE_INVALID", "PRIVATE_SERVICE_CONFIG_INVALID"].includes(
        e.message,
      )
        ? e.message
        : "SERVICE_START_FAILED",
    );
    process.exitCode = 1;
  }
}
module.exports = { readConfig };
