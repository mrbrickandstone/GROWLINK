"use strict";
const crypto = require("node:crypto");
const { error } = require("./store.cjs");
const { timingEqual } = require("./watchdog.cjs");
const SERVICE = "farber-security-control";
function signature(payload, token) {
  return crypto
    .createHmac("sha256", token)
    .update("farber-readiness-v1\n" + JSON.stringify(payload))
    .digest("hex");
}
function readiness(store, { nonce, token, signInConfigured }) {
  if (!token || token.length < 32) throw error("HEALTH_TOKEN_REQUIRED", 503);
  if (!/^[a-f0-9]{64}$/.test(nonce || ""))
    throw error("HEALTH_CHALLENGE_REQUIRED");
  let databaseReadable = false;
  try {
    store.db.prepare("SELECT id FROM records LIMIT 1").get();
    databaseReadable = true;
  } catch {}
  const payload = {
    service: SERVICE,
    version: 1,
    nonce,
    now: store.now(),
    databaseReadable,
    signInConfigured: signInConfigured === true,
    recordingControlledByDashboard: false,
  };
  return { payload, signature: signature(payload, token) };
}
function validReadiness(value, { nonce, token, now }) {
  const p = value?.payload;
  return !!(
    p &&
    p.service === SERVICE &&
    p.version === 1 &&
    p.nonce === nonce &&
    Number.isSafeInteger(p.now) &&
    Math.abs(p.now - now) <= 60000 &&
    typeof p.databaseReadable === "boolean" &&
    typeof p.signInConfigured === "boolean" &&
    p.recordingControlledByDashboard === false &&
    /^[a-f0-9]{64}$/.test(value.signature || "") &&
    timingEqual(value.signature, signature(p, token))
  );
}
module.exports = { readiness, validReadiness };
