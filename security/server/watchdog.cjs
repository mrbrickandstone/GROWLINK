"use strict";
const crypto = require("node:crypto");
const { error } = require("./store.cjs");
const { FAULT_CODES, FAULT_LABELS } = require("./pipeline.cjs");
function timingEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto
      .createHash("sha256")
      .update(a || "")
      .digest(),
    crypto
      .createHash("sha256")
      .update(b || "")
      .digest(),
  );
}
class Watchdog {
  constructor(
    store,
    { expected = ["archive-worker"], startedAt = store.now(), notify } = {},
  ) {
    this.store = store;
    this.expected = expected;
    this.notify = notify;
    this.startedAt = store.get("watchdog", "started")?.at || startedAt;
    store.put("watchdog", "started", { at: this.startedAt });
  }
  heartbeat(component, status, faultCodes = []) {
    if (
      !this.expected.includes(component) ||
      !["ok", "failed", "unknown"].includes(status) ||
      !Array.isArray(faultCodes) ||
      faultCodes.length > FAULT_CODES.length ||
      faultCodes.some((code) => !FAULT_CODES.includes(code)) ||
      (status === "ok" && faultCodes.length)
    )
      throw error("INVALID_HEARTBEAT");
    this.store.heartbeat(component, {
      status,
      faultCodes: [...new Set(faultCodes)].sort(),
    });
  }
  async tick() {
    const now = this.store.now();
    for (const component of this.expected) {
      const h = this.store.get("heartbeats", component),
        since = Math.min(h?.at || this.startedAt, now),
        fault = h
          ? h.status !== "ok" || now - h.at > 90000 || h.at > now
          : now - this.startedAt > 90000,
        id = component;
      let incident = this.store.get("incidents", id);
      if (fault) {
        const faultCodes =
          !h || now - h.at > 90000 || h.at > now
            ? ["HEARTBEAT_MISSING"]
            : h.faultCodes?.length
              ? h.faultCodes
              : [
                  h.status === "unknown"
                    ? "HEARTBEAT_UNKNOWN"
                    : "COMPONENT_FAILED",
                ];
        if (!incident || incident.resolvedAt) {
          incident = {
            id,
            component,
            faultAt: since,
            detectedAt: now,
            lastAttemptAt: 0,
            attempts: 0,
            providerAcceptedAt: null,
            recipientReceivedAt: null,
            resolvedAt: null,
            revision: 1,
            revisionFaultAt: since,
            faultCodes,
            priorDispatches: [],
          };
          this.store.put("incidents", id, incident);
          this.store.audit({ id: "watchdog" }, "incident.opened", {
            component,
            faultAt: incident.faultAt,
            faultCodes,
          });
        } else if (
          faultCodes.some((code) => !(incident.faultCodes || []).includes(code))
        ) {
          incident.priorDispatches = [
            ...(incident.priorDispatches || []),
            {
              revision: incident.revision || 1,
              faultCodes: incident.faultCodes || [],
              providerAcceptedAt: incident.providerAcceptedAt,
              recipientReceivedAt: incident.recipientReceivedAt,
            },
          ].slice(-20);
          incident.revision = (incident.revision || 1) + 1;
          incident.revisionFaultAt = now;
          incident.providerAcceptedAt = null;
          incident.providerReceipt = null;
          incident.recipientReceivedAt = null;
          incident.lastAttemptAt = 0;
          incident.lastError = null;
          this.store.audit({ id: "watchdog" }, "incident.escalated", {
            component,
            revision: incident.revision,
            faultCodes,
          });
        }
        incident.faultCodes = faultCodes;
        if (
          !incident.providerAcceptedAt &&
          this.notify &&
          (now - incident.lastAttemptAt >= 30000 ||
            incident.lastAttemptAt > now)
        ) {
          incident.lastAttemptAt = now;
          incident.attempts++;
          this.store.put("incidents", id, incident);
          try {
            const receipt = await this.notify({
              id: `${id}:${incident.faultAt}:${incident.revision || 1}`,
              component,
              faultAt: incident.faultAt,
              detectedAt: incident.detectedAt,
              revision: incident.revision || 1,
              revisionFaultAt: incident.revisionFaultAt || incident.faultAt,
              faultCodes: incident.faultCodes,
              message:
                incident.faultCodes
                  .map(
                    (code) =>
                      FAULT_LABELS[code] ||
                      "Security component failed or stopped reporting",
                  )
                  .join(". ") +
                ". Investigate recording and archive continuity.",
            });
            incident.providerAcceptedAt = this.store.now();
            incident.providerReceipt = receipt || null;
            this.store.audit(
              { id: "watchdog" },
              "notification.provider.accepted",
              {
                component,
                revision: incident.revision || 1,
                receipt: incident.providerReceipt,
              },
            );
          } catch {
            incident.lastError = "NOTIFICATION_NOT_ACCEPTED";
            this.store.audit(
              { id: "watchdog" },
              "notification.provider.failed",
              { component, revision: incident.revision || 1 },
            );
          }
        }
        incident.deliveryWithinFiveMinutes = incident.recipientReceivedAt
          ? incident.recipientReceivedAt -
              (incident.revisionFaultAt || incident.faultAt) <=
            300000
          : null;
        incident.deliveryUnconfirmedAfterFiveMinutes =
          now - (incident.revisionFaultAt || incident.faultAt) > 300000 &&
          !incident.recipientReceivedAt;
        this.store.put("incidents", id, incident);
      } else if (!fault && incident && !incident.resolvedAt) {
        incident.resolvedAt = now;
        this.store.put("incidents", id, incident);
        this.store.audit({ id: "watchdog" }, "incident.resolved", {
          component,
          faultAt: incident.faultAt,
        });
      }
    }
    return this.store.all("incidents");
  }
}
function webhookNotifier(env) {
  if (!env.SECURITY_ALERT_WEBHOOK) return undefined;
  if (new URL(env.SECURITY_ALERT_WEBHOOK).protocol !== "https:")
    throw error("NOTIFIER_HTTPS_REQUIRED");
  return async (payload) => {
    const r = await fetch(env.SECURITY_ALERT_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payload.id,
        ...(env.SECURITY_ALERT_TOKEN
          ? { Authorization: `Bearer ${env.SECURITY_ALERT_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    await r.body?.cancel();
    if (!r.ok) throw error("NOTIFIER_HTTP_FAILED");
    return {
      accepted: true,
      status: r.status,
      receiptId: r.headers.get("x-request-id"),
    };
  };
}
module.exports = { Watchdog, timingEqual, webhookNotifier };
