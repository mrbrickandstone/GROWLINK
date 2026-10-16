"use strict";
const crypto = require("node:crypto");
const { validReadiness } = require("./health.cjs");
const { error } = require("./store.cjs");
const CONTROL = "control-web";
function endpoint(value, token, health = false) {
  if (!value && !token) return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      !token ||
      token.length < 32 ||
      (health && (u.pathname !== "/healthz/ready" || u.search))
    )
      throw Error();
    return { url: u.href, token };
  } catch {
    throw error("MONITOR_ENDPOINT_CONFIG_INVALID");
  }
}
function options(env = {}) {
  const control = endpoint(
    env.SECURITY_CONTROL_HEALTH_URL,
    env.SECURITY_CONTROL_HEALTH_TOKEN,
    true,
  );
  const deadman = endpoint(
    env.SECURITY_DEADMAN_URL,
    env.SECURITY_DEADMAN_TOKEN,
  );
  const credentials = [
    env.SECURITY_WATCHDOG_TOKEN,
    control?.token,
    deadman?.token,
  ].filter(Boolean);
  if (new Set(credentials).size !== credentials.length)
    throw error("MONITOR_CREDENTIALS_MUST_BE_SEPARATE");
  return { control, deadman };
}
async function readSmall(response) {
  if (
    !/^application\/json(?:;|$)/i.test(
      response.headers.get("content-type") || "",
    )
  )
    throw Error();
  let n = 0;
  const chunks = [];
  for await (const c of response.body) {
    n += c.length;
    if (n > 4096) throw Error();
    chunks.push(Buffer.from(c));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function probeControl(
  config,
  { fetch: request = fetch, now = Date.now, timeoutMs = 10000 } = {},
) {
  const nonce = crypto.randomBytes(32).toString("hex");
  let response;
  try {
    const url = new URL(config.url);
    url.searchParams.set("nonce", nonce);
    response = await request(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + config.token,
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![200, 503].includes(response.status)) throw Error();
    let value;
    try {
      value = await readSmall(response);
    } catch {
      return { status: "failed", faultCodes: ["CONTROL_HEALTH_INVALID"] };
    }
    if (!validReadiness(value, { nonce, token: config.token, now: now() }))
      return { status: "failed", faultCodes: ["CONTROL_HEALTH_INVALID"] };
    const faultCodes = [];
    if (!value.payload.databaseReadable)
      faultCodes.push("CONTROL_DATABASE_FAILED");
    if (!value.payload.signInConfigured)
      faultCodes.push("CONTROL_SIGN_IN_UNCONFIGURED");
    if (response.status !== 200 && !faultCodes.length)
      faultCodes.push("CONTROL_HEALTH_INVALID");
    return { status: faultCodes.length ? "failed" : "ok", faultCodes };
  } catch {
    return { status: "failed", faultCodes: ["CONTROL_UNREACHABLE"] };
  } finally {
    try {
      await response?.body?.cancel();
    } catch {}
  }
}
async function pulse(
  config,
  payload,
  { fetch: request = fetch, timeoutMs = 10000 } = {},
) {
  let response;
  try {
    response = await request(config.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.token,
        "Content-Type": "application/json",
        "Idempotency-Key": payload.id,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Error();
  } catch {
    throw error("DEADMAN_PULSE_FAILED", 503);
  } finally {
    try {
      await response?.body?.cancel();
    } catch {}
  }
}
class MonitoringCycle {
  constructor(store, dog, config, io = {}) {
    this.store = store;
    this.dog = dog;
    this.config = config;
    this.io = io;
    this.running = false;
  }
  async run() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const startedAt = this.store.now();
      if (this.config.control) {
        const result = await probeControl(this.config.control, {
          ...this.io,
          now: () => this.store.now(),
        });
        this.dog.heartbeat(CONTROL, result.status, result.faultCodes);
        this.store.put("watchdog-checks", CONTROL, {
          component: CONTROL,
          at: this.store.now(),
          ...result,
        });
      }
      const incidents = await this.dog.tick();
      const previous = this.store.get("watchdog", "cycle");
      const record = {
        sequence: (previous?.sequence || 0) + 1,
        startedAt,
        completedAt: this.store.now(),
        controlProbeConfigured: !!this.config.control,
        deadmanConfigured: !!this.config.deadman,
        deadmanState: "unconfigured",
        notificationDispatchConfigured: typeof this.dog.notify === "function",
      };
      this.store.put("watchdog", "cycle", record);
      this.store.db
        .prepare(
          "DELETE FROM records WHERE kind='watchdog' AND id='cycle-error'",
        )
        .run();
      if (this.config.deadman) {
        const notificationReady =
          record.notificationDispatchConfigured &&
          incidents.every((i) => i.resolvedAt || i.providerAcceptedAt);
        if (!notificationReady)
          record.deadmanState = "withheld-notification-path";
        else
          try {
            await pulse(
              this.config.deadman,
              {
                id: `farber-watchdog:${startedAt}:${record.sequence}`,
                service: "farber-watchdog",
                checkedAt: record.completedAt,
                sequence: record.sequence,
              },
              this.io,
            );
            record.deadmanState = "accepted";
            record.deadmanAcceptedAt = this.store.now();
          } catch {
            record.deadmanState = "failed";
          }
        this.store.put("watchdog", "cycle", record);
      }
      return record;
    } finally {
      this.running = false;
    }
  }
}
module.exports = { CONTROL, options, probeControl, pulse, MonitoringCycle };
