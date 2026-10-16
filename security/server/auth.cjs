"use strict";
const crypto = require("node:crypto");
const { error } = require("./store.cjs");
const cookie = (req, name) => {
  const pairs = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim().split("="));
  return pairs.find((p) => p[0] === name)?.[1] || null;
};
function createAuth(store, env, origin) {
  const secure = origin.startsWith("https:"),
    name = secure ? "__Host-farber-session" : "farber-session",
    flowName = secure ? "__Host-farber-flow" : "farber-flow";
  let discovery;
  const setCookie = (res, n, v, age) => {
    const prior = res.getHeader("Set-Cookie") || [];
    res.setHeader("Set-Cookie", [
      ...(Array.isArray(prior) ? prior : [prior]),
      `${n}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`,
    ]);
  };
  async function config() {
    if (
      !env.SECURITY_OIDC_ISSUER ||
      !env.SECURITY_OIDC_CLIENT_ID ||
      !env.SECURITY_OIDC_CLIENT_SECRET
    )
      throw error("NAMED_SIGN_IN_NOT_CONFIGURED", 503);
    if (new URL(env.SECURITY_OIDC_ISSUER).protocol !== "https:")
      throw error("OIDC_HTTPS_REQUIRED", 503);
    const client = await import("openid-client");
    if (!discovery)
      discovery = client
        .discovery(
          new URL(env.SECURITY_OIDC_ISSUER),
          env.SECURITY_OIDC_CLIENT_ID,
          env.SECURITY_OIDC_CLIENT_SECRET,
          undefined,
          { timeout: 10, execute: [client.enableNonRepudiationChecks] },
        )
        .catch((e) => {
          discovery = null;
          throw e;
        });
    return { client, configuration: await discovery };
  }
  return {
    configured: !!(
      env.SECURITY_OIDC_ISSUER &&
      env.SECURITY_OIDC_CLIENT_ID &&
      env.SECURITY_OIDC_CLIENT_SECRET
    ),
    async login(req, res) {
      const rateId = crypto
          .createHash("sha256")
          .update(req.socket.remoteAddress || "unknown")
          .digest("hex"),
        now = store.now();
      const prior = store.get("login-rate", rateId);
      const rate =
        prior && now - prior.start < 600000 ? prior : { start: now, count: 0 };
      if (rate.count >= 20) throw error("LOGIN_RATE_LIMIT", 429);
      rate.count++;
      store.put("login-rate", rateId, rate);
      store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
      const { client, configuration } = await config();
      const id = crypto.randomBytes(32).toString("hex"),
        verifier = client.randomPKCECodeVerifier(),
        state = client.randomState(),
        nonce = client.randomNonce();
      store.session(
        id,
        { kind: "oidc-flow", verifier, state, nonce },
        store.now() + 600000,
      );
      setCookie(res, flowName, id, 600);
      const url = client.buildAuthorizationUrl(configuration, {
        redirect_uri: origin + "/auth/callback",
        scope: "openid profile",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
        max_age: "0",
        ...(env.SECURITY_OIDC_ACR ? { acr_values: env.SECURITY_OIDC_ACR } : {}),
      });
      res.writeHead(302, { Location: url.href });
      res.end();
    },
    async callback(req, res, url) {
      const flowId = cookie(req, flowName),
        flow = store.consumeSession(flowId, "oidc-flow");
      setCookie(res, flowName, "", 0);
      if (flow?.kind !== "oidc-flow") throw error("LOGIN_EXPIRED", 401);
      const { client, configuration } = await config();
      const tokens = await client.authorizationCodeGrant(configuration, url, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
        maxAge: 0,
      });
      const claims = tokens.claims();
      const id = claims?.iss + "|" + claims?.sub;
      const mfa = Array.isArray(claims.amr) && claims.amr.includes("mfa");
      const sid = crypto.randomBytes(32).toString("hex"),
        csrf = crypto.randomBytes(32).toString("hex"),
        now = store.now(),
        expires = Math.min(now + 8 * 3600000, claims.exp * 1000),
        age = Math.floor((expires - now) / 1000);
      if (!Number.isFinite(age) || age <= 0) throw error("LOGIN_EXPIRED", 401);
      store.tx(() => {
        const u = store.user(id);
        if (!u) throw error("NAMED_USER_NOT_PROVISIONED", 403);
        if (u.role === "owner" && !mfa) throw error("OWNER_MFA_REQUIRED", 403);
        store.removeSession(cookie(req, name));
        store.session(sid, { kind: "user", userId: u.id, mfa, csrf }, expires);
        store.audit(u, "session.created", { mfa });
      });
      setCookie(res, name, sid, age);
      res.writeHead(302, { Location: "/" });
      res.end();
    },
    principal(req) {
      const s = store.getSession(cookie(req, name));
      if (s?.kind !== "user") return null;
      const u = store.user(s.userId);
      if (u?.role === "owner" && !s.mfa) return null;
      return u
        ? { ...u, mfa: s.mfa, csrf: s.csrf, externalAuthenticated: true }
        : null;
    },
    logout(req, res) {
      store.removeSession(cookie(req, name));
      setCookie(res, name, "", 0);
    },
    checkWrite(req, actor) {
      if (
        req.headers.origin !== origin ||
        req.headers["x-csrf-token"] !== actor?.csrf
      )
        throw error("REQUEST_ORIGIN_OR_CSRF_DENIED", 403);
    },
  };
}
module.exports = { createAuth, cookie };
