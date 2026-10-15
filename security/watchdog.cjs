"use strict";
process.umask(0o077);
const http = require("node:http"),
  path = require("node:path");
const { Store } = require("./server/store.cjs");
const {
  Watchdog,
  timingEqual,
  webhookNotifier,
} = require("./server/watchdog.cjs");
const token = process.env.SECURITY_WATCHDOG_TOKEN;
if (!token || token.length < 32) {
  console.error("WATCHDOG_TOKEN_REQUIRED");
  process.exit(1);
}
const store = new Store(
  process.env.SECURITY_WATCHDOG_DIR ||
    path.join(__dirname, "../.security-watchdog"),
);
const dog = new Watchdog(store, {
  expected: (
    process.env.SECURITY_EXPECTED_COMPONENTS || "archive-worker"
  ).split(","),
  notify: webhookNotifier(process.env),
});
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!timingEqual(req.headers.authorization, "Bearer " + token)) {
    res.writeHead(401);
    return res.end();
  }
  try {
    if (req.method === "POST" && req.url === "/heartbeat") {
      let b = "",
        n = 0;
      for await (const c of req) {
        n += c.length;
        if (n > 4096) throw Error();
        b += c;
      }
      const j = JSON.parse(b);
      dog.heartbeat(j.component, j.status);
      res.writeHead(204);
      res.end();
    } else if (req.method === "GET" && req.url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          now: store.now(),
          incidents: store.all("incidents"),
          deliveryCommissioned: false,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch {
    res.writeHead(400);
    res.end();
  }
});
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await dog.tick();
  } finally {
    checking = false;
  }
}, 30000);
server.listen(
  Number(process.env.SECURITY_WATCHDOG_PORT || 4320),
  process.env.SECURITY_WATCHDOG_HOST || "127.0.0.1",
  () =>
    console.log(
      "Independent watchdog started; delivery commissioning still required.",
    ),
);
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
