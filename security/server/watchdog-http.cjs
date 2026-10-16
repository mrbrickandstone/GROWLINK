"use strict";
const http = require("node:http");
const { timingEqual } = require("./watchdog.cjs");
const { CONTROL } = require("./watchdog-checks.cjs");
function createWatchdogServer({ store, dog, token }) {
  if (!token || token.length < 32) throw Error("WATCHDOG_TOKEN_REQUIRED");
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
        // A worker credential cannot impersonate an independently observed probe.
        if (
          j.component === CONTROL ||
          j.faultCodes?.some((code) => String(code).startsWith("CONTROL_"))
        )
          throw Error();
        dog.heartbeat(j.component, j.status, j.faultCodes);
        res.writeHead(204);
        res.end();
      } else if (req.method === "GET" && req.url === "/status") {
        const cycle = store.get("watchdog", "cycle"),
          now = store.now();
        const cycleFresh = !!(
          cycle &&
          cycle.completedAt <= now &&
          now - cycle.completedAt < 90000 &&
          !store.get("watchdog", "cycle-error")
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            now,
            incidents: store.all("incidents"),
            checks: store.all("watchdog-checks"),
            cycle,
            cycleFresh,
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
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createWatchdogServer };
