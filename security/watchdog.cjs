"use strict";
process.umask(0o077);
const path = require("node:path");
const { Store } = require("./server/store.cjs");
const { Watchdog, webhookNotifier } = require("./server/watchdog.cjs");
const {
  CONTROL,
  options,
  MonitoringCycle,
} = require("./server/watchdog-checks.cjs");
const { createWatchdogServer } = require("./server/watchdog-http.cjs");
try {
  const token = process.env.SECURITY_WATCHDOG_TOKEN;
  if (!token || token.length < 32) throw Error();
  const config = options(process.env);
  const port = Number(process.env.SECURITY_WATCHDOG_PORT || 4320);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error();
  const expected = (
    process.env.SECURITY_EXPECTED_COMPONENTS || "archive-worker"
  ).split(",");
  if (expected.includes(CONTROL)) throw Error();
  if (config.control) expected.push(CONTROL);
  const store = new Store(
    process.env.SECURITY_WATCHDOG_DIR ||
      path.join(__dirname, "../.security-watchdog"),
  );
  const dog = new Watchdog(store, {
    expected,
    notify: webhookNotifier(process.env),
  });
  const cycle = new MonitoringCycle(store, dog, config);
  const server = createWatchdogServer({ store, dog, token });
  let running = null,
    stopped = false;
  function check() {
    if (stopped || running) return;
    running = cycle
      .run()
      .catch(() => {
        try {
          store.put("watchdog", "cycle-error", {
            at: store.now(),
            code: "MONITORING_CYCLE_FAILED",
          });
        } catch {}
        console.error("MONITORING_CYCLE_FAILED");
      })
      .finally(() => {
        running = null;
      });
  }
  const timer = setInterval(check, 30000);
  server.on("error", () => {
    clearInterval(timer);
    console.error("WATCHDOG_LISTEN_FAILED");
    process.exitCode = 1;
  });
  server.listen(port, process.env.SECURITY_WATCHDOG_HOST || "127.0.0.1", () => {
    console.log(
      "Independent watchdog started; delivery commissioning still required.",
    );
    check();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopped = true;
      clearInterval(timer);
      server.close(async () => {
        await running;
        store.close();
        process.exit(0);
      });
    });
} catch {
  console.error("WATCHDOG_CONFIG_INVALID");
  process.exitCode = 1;
}
