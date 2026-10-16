"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  https = require("node:https"),
  net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { Store } = require("../../security/server/store.cjs");
const { LocalArchive } = require("../../security/server/archive.cjs");
const { createServer } = require("../../security/server/http.cjs");
const {
  readiness,
  validReadiness,
} = require("../../security/server/health.cjs");
const { Watchdog } = require("../../security/server/watchdog.cjs");
const {
  options,
  probeControl,
  MonitoringCycle,
} = require("../../security/server/watchdog-checks.cjs");
const {
  createWatchdogServer,
} = require("../../security/server/watchdog-http.cjs");
const { readConfig } = require("../../security/deploy/run-service.cjs");
const healthToken = "health-fixture-" + "h".repeat(40),
  workerToken = "worker-fixture-" + "w".repeat(40),
  deadmanToken = "deadman-fixture-" + "d".repeat(40);
const control = {
    url: "https://control.example.invalid/healthz/ready",
    token: healthToken,
  },
  deadman = {
    url: "https://secondary.example.invalid/pulse",
    token: deadmanToken,
  };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-monitoring-"));
  let now = Date.now();
  const store = new Store(root, { now: () => now });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, now: () => now, advance: (n) => (now += n) };
}
async function listen(t, server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function web(t, f, { review = false, enabled = true } = {}) {
  const reserve = net.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    SECURITY_OIDC_ISSUER: "https://identity.example.invalid",
    SECURITY_OIDC_CLIENT_ID: "fixture",
    SECURITY_OIDC_CLIENT_SECRET: "fixture",
    ...(enabled ? { SECURITY_HEALTH_TOKEN: healthToken } : {}),
  };
  const server = createServer({
    store: f.store,
    archive: new LocalArchive(path.join(f.root, "archive")),
    env,
    origin,
    review,
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return { origin, server };
}
function signed(f, nonce, signInConfigured = true) {
  return readiness(f.store, { nonce, token: healthToken, signInConfigured });
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
test("dashboard readiness is a private signed fresh challenge and its credential grants no camera access", async (t) => {
  const f = fixture(t),
    w = await web(t, f),
    nonce = "a".repeat(64),
    url = w.origin + "/healthz/ready?nonce=" + nonce;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Authorization: "Bearer " + workerToken } }))
      .status,
    401,
  );
  const headers = { Authorization: "Bearer " + healthToken };
  const r = await fetch(url, { headers }),
    value = await r.json();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(
    validReadiness(value, { nonce, token: healthToken, now: f.now() }),
    true,
  );
  assert.equal(
    validReadiness(value, {
      nonce: "b".repeat(64),
      token: healthToken,
      now: f.now(),
    }),
    false,
  );
  assert.equal(
    validReadiness(value, { nonce, token: healthToken, now: f.now() + 60001 }),
    false,
  );
  value.payload.databaseReadable = false;
  assert.equal(
    validReadiness(value, { nonce, token: healthToken, now: f.now() }),
    false,
  );
  assert.equal(
    (await fetch(w.origin + "/api/overview", { headers })).status,
    401,
  );
  assert.equal(
    (await fetch(w.origin + "/healthz/ready", { headers })).status,
    400,
  );
  assert.equal((await fetch(url, { method: "POST", headers })).status, 401);
  assert.equal(JSON.stringify(value).includes(healthToken), false);
  const disabled = await web(t, f, { enabled: false });
  assert.equal(
    (
      await fetch(disabled.origin + "/healthz/ready?nonce=" + nonce, {
        headers,
      })
    ).status,
    404,
  );
});
test("readiness exposes database read failure and unconfigured named sign-in without claiming camera or IdP health", async (t) => {
  const f = fixture(t),
    w = await web(t, f),
    nonce = "c".repeat(64),
    headers = { Authorization: "Bearer " + healthToken };
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql === "SELECT id FROM records LIMIT 1")
      throw Error("PRIVATE_DATABASE_ERROR");
    return prepare(sql);
  };
  let r = await fetch(w.origin + "/healthz/ready?nonce=" + nonce, { headers }),
    value = await r.json();
  assert.equal(r.status, 503);
  assert.equal(value.payload.databaseReadable, false);
  assert.equal(
    validReadiness(value, { nonce, token: healthToken, now: f.now() }),
    true,
  );
  assert.equal(JSON.stringify(value).includes("PRIVATE_DATABASE"), false);
  f.store.db.prepare = prepare;
  const review = await web(t, f, { review: true });
  r = await fetch(review.origin + "/healthz/ready?nonce=" + nonce, { headers });
  value = await r.json();
  assert.equal(r.status, 503);
  assert.equal(value.payload.signInConfigured, false);
  assert.equal(value.payload.recordingControlledByDashboard, false);
});
test("external probe rejects stale, forged, oversized, redirected and timed-out responses", async (t) => {
  const f = fixture(t);
  for (const mode of [
    "good",
    "stale",
    "cached",
    "signature",
    "oversize",
    "html",
    "denied",
    "database",
    "signin",
    "timeout",
  ]) {
    const request = async (u, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer " + healthToken);
      const nonce = new URL(u).searchParams.get("nonce");
      if (mode === "timeout")
        return new Promise((_, reject) =>
          init.signal.addEventListener(
            "abort",
            () => reject(Error("PRIVATE_NETWORK_DETAIL")),
            { once: true },
          ),
        );
      if (mode === "oversize") return response({ junk: "x".repeat(5000) });
      if (mode === "html")
        return new Response("login", {
          headers: { "Content-Type": "text/html" },
        });
      if (mode === "denied") return new Response(null, { status: 302 });
      let value = signed(
        f,
        mode === "cached" ? "0".repeat(64) : nonce,
        mode !== "signin",
      );
      if (mode === "stale") {
        const at = f.now();
        f.advance(-61000);
        value = signed(f, nonce);
        f.advance(at - f.now());
      }
      if (mode === "signature") value.signature = "0".repeat(64);
      if (mode === "database") {
        const broken = {
          now: f.now,
          db: {
            prepare: () => {
              throw Error();
            },
          },
        };
        value = readiness(broken, {
          nonce,
          token: healthToken,
          signInConfigured: true,
        });
      }
      return response(value, ["database", "signin"].includes(mode) ? 503 : 200);
    };
    const keepAlive = setTimeout(() => {}, 1000);
    const result = await probeControl(control, {
      fetch: request,
      now: f.now,
      timeoutMs: 20,
    });
    clearTimeout(keepAlive);
    assert.equal(result.status, mode === "good" ? "ok" : "failed", mode);
    if (mode === "database")
      assert.deepEqual(result.faultCodes, ["CONTROL_DATABASE_FAILED"]);
    if (mode === "signin")
      assert.deepEqual(result.faultCodes, ["CONTROL_SIGN_IN_UNCONFIGURED"]);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
});
test("monitor endpoints and credentials fail closed and service configs keep roles separate", (t) => {
  const f = fixture(t);
  assert.deepEqual(options(), { control: null, deadman: null });
  const good = {
    SECURITY_WATCHDOG_TOKEN: workerToken,
    SECURITY_CONTROL_HEALTH_URL: control.url,
    SECURITY_CONTROL_HEALTH_TOKEN: healthToken,
    SECURITY_DEADMAN_URL: deadman.url,
    SECURITY_DEADMAN_TOKEN: deadmanToken,
  };
  assert.equal(options(good).control.url, control.url);
  for (const change of [
    { SECURITY_CONTROL_HEALTH_URL: "http://host/healthz/ready" },
    { SECURITY_CONTROL_HEALTH_URL: "https://host/wrong" },
    { SECURITY_CONTROL_HEALTH_URL: control.url + "?nonce=a" },
    { SECURITY_DEADMAN_URL: "https://user:secret@host/pulse" },
    { SECURITY_DEADMAN_TOKEN: "" },
    { SECURITY_CONTROL_HEALTH_TOKEN: workerToken },
  ])
    assert.throws(() => options({ ...good, ...change }), /MONITOR_/);
  assert.throws(
    () =>
      new Watchdog(f.store, { expected: ["archive-worker", "archive-worker"] }),
    /INVALID_EXPECTED/,
  );
  assert.throws(
    () =>
      new Watchdog(f.store, {
        expected: Array.from({ length: 9 }, (_, i) => "worker-" + i),
      }),
    /INVALID_EXPECTED/,
  );
  const file = path.join(f.root, "monitor.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ SECURITY_WATCHDOG_DIR: f.root, ...good }),
    { mode: 0o600 },
  );
  assert.equal(
    readConfig("watchdog", file).SECURITY_DEADMAN_TOKEN,
    deadmanToken,
  );
  assert.throws(
    () => readConfig("worker", file),
    /PRIVATE_SERVICE_CONFIG_INVALID/,
  );
  for (const port of ["0", "invalid"]) {
    const run = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../security/watchdog.cjs")],
      {
        env: {
          PATH: process.env.PATH,
          SECURITY_WATCHDOG_TOKEN: workerToken,
          SECURITY_WATCHDOG_PORT: port,
        },
        encoding: "utf8",
        timeout: 1000,
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /WATCHDOG_CONFIG_INVALID/);
    assert.equal(run.stderr.includes(workerToken), false);
  }
});
test("a dashboard failure notifies independently while successful monitoring continues its separate deadman pulse", async (t) => {
  const f = fixture(t),
    notifications = [],
    pulses = [];
  const dog = new Watchdog(f.store, {
    expected: ["archive-worker", "control-web"],
    notify: async (p) => {
      notifications.push(p);
      return { accepted: true };
    },
  });
  dog.heartbeat("archive-worker", "ok");
  let release;
  const cycle = new MonitoringCycle(
    f.store,
    dog,
    { control, deadman },
    {
      fetch: async (u, init) => {
        if (String(u).startsWith(control.url)) {
          await new Promise((r) => (release = r));
          throw Error("PRIVATE_TLS_FAILURE");
        }
        pulses.push(JSON.parse(init.body));
        assert.equal(init.headers.Authorization, "Bearer " + deadmanToken);
        return new Response(null, { status: 204 });
      },
    },
  );
  const running = cycle.run();
  assert.deepEqual(await cycle.run(), { skipped: true });
  release();
  const result = await running;
  assert.equal(result.deadmanState, "accepted");
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].faultCodes, ["CONTROL_UNREACHABLE"]);
  assert.equal(
    f.store.get("incidents", "control-web").deliveryWithinFiveMinutes,
    null,
  );
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].service, "farber-watchdog");
  assert.equal(
    JSON.stringify(f.store.all("watchdog")).includes(deadmanToken),
    false,
  );
});
test("notification failure withholds the secondary pulse and restart retries the same incident before resuming", async (t) => {
  const f = fixture(t),
    ids = [],
    pulses = [];
  let accept = false;
  const notify = async (p) => {
    ids.push(p.id);
    if (!accept) throw Error("PRIVATE_NOTIFY_DETAIL");
    return { accepted: true };
  };
  const io = {
    fetch: async (u, init) => {
      pulses.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  };
  let dog = new Watchdog(f.store, { notify });
  dog.heartbeat("archive-worker", "failed", ["TRANSFER_FAILED"]);
  let cycle = new MonitoringCycle(f.store, dog, { control: null, deadman }, io);
  assert.equal((await cycle.run()).deadmanState, "withheld-notification-path");
  assert.equal(pulses.length, 0);
  f.advance(31000);
  accept = true;
  const reopened = new Store(f.root, { now: f.now });
  try {
    dog = new Watchdog(reopened, { notify });
    cycle = new MonitoringCycle(reopened, dog, { control: null, deadman }, io);
    const result = await cycle.run();
    assert.equal(result.deadmanState, "accepted");
    assert.equal(result.sequence, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(pulses.length, 1);
  } finally {
    reopened.close();
  }
  dog = new Watchdog(f.store);
  cycle = new MonitoringCycle(f.store, dog, { control: null, deadman }, io);
  assert.equal((await cycle.run()).deadmanState, "withheld-notification-path");
});
test("secondary endpoint failures remain explicit without storing credentials or claiming recipient delivery", async (t) => {
  const f = fixture(t),
    dog = new Watchdog(f.store, { notify: async () => ({ accepted: true }) });
  dog.heartbeat("archive-worker", "ok");
  f.store.put("watchdog", "cycle-error", { code: "PRIOR_FAILURE" });
  const cycle = new MonitoringCycle(
    f.store,
    dog,
    { control: null, deadman },
    {
      fetch: async () => {
        throw Error(deadmanToken);
      },
    },
  );
  const r = await cycle.run();
  assert.equal(r.deadmanState, "failed");
  assert.equal(r.sequence, 1);
  assert.equal(f.store.get("watchdog", "cycle-error"), null);
  assert.equal(
    JSON.stringify(f.store.all("watchdog")).includes(deadmanToken),
    false,
  );
});
test("worker heartbeat credentials cannot forge the independent dashboard probe and status exposes cycle freshness", async (t) => {
  const f = fixture(t),
    dog = new Watchdog(f.store, {
      expected: ["archive-worker", "control-web"],
    });
  const origin = await listen(
    t,
    createWatchdogServer({ store: f.store, dog, token: workerToken }),
  );
  const send = (body) =>
    fetch(origin + "/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer " + workerToken },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await send({ component: "control-web", status: "ok" })).status,
    400,
  );
  assert.equal(
    (
      await send({
        component: "archive-worker",
        status: "failed",
        faultCodes: ["CONTROL_UNREACHABLE"],
      })
    ).status,
    400,
  );
  assert.equal(
    (await send({ component: "archive-worker", status: "ok" })).status,
    204,
  );
  assert.equal(f.store.get("heartbeats", "control-web"), null);
  assert.equal((await fetch(origin + "/status")).status, 401);
  const status = async () =>
    (
      await fetch(origin + "/status", {
        headers: { Authorization: "Bearer " + workerToken },
      })
    ).json();
  assert.equal((await status()).cycleFresh, false);
  f.store.put("watchdog", "cycle", { completedAt: f.now() });
  assert.equal((await status()).cycleFresh, true);
  f.advance(90000);
  assert.equal((await status()).cycleFresh, false);
  assert.equal((await status()).deliveryCommissioned, false);
});
test(
  "real watchdog process uses private TLS fixtures and preserves cycle state across SIGKILL and restart",
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t),
      key = path.join(f.root, "fixture-key.pem"),
      cert = path.join(f.root, "fixture-cert.pem");
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      made.status,
      0,
      "Local TLS fixture certificate generation failed",
    );
    const pulses = [],
      alerts = [];
    let failControl = false;
    const target = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      async (req, res) => {
        if (req.url.startsWith("/healthz/ready")) {
          assert.equal(req.headers.authorization, "Bearer " + healthToken);
          if (failControl) {
            res.writeHead(503);
            return res.end();
          }
          const nonce = new URL(
            req.url,
            "https://fixture.invalid",
          ).searchParams.get("nonce");
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(signed(f, nonce)));
        }
        let text = "";
        for await (const c of req) text += c;
        if (req.url === "/pulse") {
          assert.equal(req.headers.authorization, "Bearer " + deadmanToken);
          pulses.push(JSON.parse(text));
        } else if (req.url === "/alert") alerts.push(JSON.parse(text));
        else assert.fail("Unexpected fixture endpoint");
        res.writeHead(204);
        res.end();
      },
    );
    await listen(t, target);
    const targetOrigin = `https://127.0.0.1:${target.address().port}`;
    const reserve = net.createServer();
    await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const start = () => {
      child = spawn(
        process.execPath,
        [path.resolve(__dirname, "../../security/watchdog.cjs")],
        {
          env: {
            PATH: process.env.PATH,
            NODE_EXTRA_CA_CERTS: cert,
            SECURITY_WATCHDOG_DIR: path.join(f.root, "dog"),
            SECURITY_WATCHDOG_PORT: String(port),
            SECURITY_WATCHDOG_TOKEN: workerToken,
            SECURITY_CONTROL_HEALTH_URL: targetOrigin + "/healthz/ready",
            SECURITY_CONTROL_HEALTH_TOKEN: healthToken,
            SECURITY_DEADMAN_URL: targetOrigin + "/pulse",
            SECURITY_DEADMAN_TOKEN: deadmanToken,
            SECURITY_ALERT_WEBHOOK: targetOrigin + "/alert",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
    };
    async function waitFor(predicate) {
      const deadline = Date.now() + 6000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "Fixture event timed out");
        assert.equal(child.exitCode, null, "Watchdog exited unexpectedly");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    start();
    await waitFor(() => pulses.length === 1);
    assert.equal(pulses[0].sequence, 1);
    child.kill("SIGKILL");
    await once(child, "exit");
    failControl = true;
    start();
    await waitFor(() => pulses.length === 2 && alerts.length === 1);
    assert.equal(pulses[1].sequence, 2);
    assert.equal(alerts[0].component, "control-web");
    assert.deepEqual(alerts[0].faultCodes, ["CONTROL_HEALTH_INVALID"]);
    const status = await (
      await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: "Bearer " + workerToken },
      })
    ).json();
    assert.equal(status.cycleFresh, true);
    assert.equal(status.deliveryCommissioned, false);
    assert.equal(status.incidents[0].recipientReceivedAt, null);
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(child.exitCode, 0);
  },
);

test("a real archive worker preserves synthetic footage while the dashboard endpoint is stopped", async (t) => {
  const f = fixture(t),
    w = await web(t, f);
  w.server.closeAllConnections();
  await new Promise((r) => w.server.close(r));
  const result = await probeControl(control, {
    now: f.now,
    fetch: (_url, init) => fetch(w.origin + "/healthz/ready", init),
  });
  assert.deepEqual(result, {
    status: "failed",
    faultCodes: ["CONTROL_UNREACHABLE"],
  });
  f.store.put("cameras", "one", {
    id: "one",
    name: "Synthetic",
    source: "ring",
    exportEnabled: false,
  });
  const file = path.join(f.root, "synthetic.mp4");
  const made = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=15:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  assert.equal(made.status, 0);
  const { hashFile } = require("../../lib/security/ring-pilot.cjs");
  const sha256 = await hashFile(file),
    size = fs.statSync(file).size;
  const id = f.store.enqueue({
    kind: "pilot-import",
    cameraId: "one",
    file,
    sha256,
    size,
    requestStart: f.now() - 10000,
    requestEnd: f.now() - 9000,
    actualStart: f.now() - 10000,
  });
  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, "../../security/worker.cjs"), "--once"],
    {
      env: {
        PATH: process.env.PATH,
        SECURITY_DATA_DIR: f.root,
        SECURITY_MIN_FREE_BYTES: "1000000000",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const segment = f.store.get("segments", id);
  assert.equal(segment.verified, true);
  assert.equal(segment.sha256, sha256);
  assert.ok(segment.derivative.video);
  assert.equal(
    f.store.db.prepare("SELECT state FROM jobs WHERE id=?").get(id).state,
    "complete",
  );
  const archive = new LocalArchive(path.join(f.root, "archive"));
  assert.equal(await archive.verify(segment.receipt), true);
  assert.equal(await hashFile(file), sha256);
});
