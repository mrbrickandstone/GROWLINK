"use strict";
// A disposable HTTPS issuer exercises the installed OIDC library, never a real account.
const fs = require("node:fs"),
  path = require("node:path"),
  https = require("node:https"),
  net = require("node:net"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { Store, digest } = require("../../security/server/store.cjs");
const { LocalArchive } = require("../../security/server/archive.cjs");
const { createServer } = require("../../security/server/http.cjs");
const [scenario, root, cert, key] = process.argv.slice(2),
  tls = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
  wrongPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "fixture-key",
  alg: "RS256",
  use: "sig",
};
let issuer,
  origin,
  provider,
  web,
  store,
  clock = Date.now(),
  responseMode = "normal",
  subject = "owner",
  discoveryDown = false,
  jwksReads = 0,
  tokenCalls = 0;
const codes = new Map(),
  jar = new Map(),
  issuedTokens = [];
const clientId = "farber-oidc-fixture",
  clientSecret = "test-only-oidc-secret";
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
function encode(v) {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}
function mint(record) {
  const now = Math.floor(Date.now() / 1000),
    payload = {
      iss: issuer,
      sub: subject,
      aud: clientId,
      iat: now,
      exp: now + 3600,
      auth_time: now,
      nonce: record.nonce,
      amr: ["pwd", "mfa"],
      role: "owner",
    };
  if (responseMode === "nonce") payload.nonce = "wrong";
  if (responseMode === "issuer") payload.iss = issuer + "/different";
  if (responseMode === "audience") payload.aud = "other-client";
  if (responseMode === "expired") payload.exp = now - 3600;
  if (responseMode === "missing-auth-time") delete payload.auth_time;
  if (responseMode === "stale-auth-time") payload.auth_time = now - 3600;
  if (responseMode === "no-mfa") payload.amr = ["pwd"];
  const input =
    encode({ alg: "RS256", kid: "fixture-key" }) + "." + encode(payload);
  const jwt =
    input +
    "." +
    crypto
      .sign(
        "sha256",
        Buffer.from(input),
        responseMode === "signature" ? wrongPair.privateKey : pair.privateKey,
      )
      .toString("base64url");
  issuedTokens.push(jwt);
  return jwt;
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
function cookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    if (/Max-Age=0(?:;|$)/.test(line)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
async function request(
  route,
  { method = "GET", body, headers = {}, cookie } = {},
) {
  const r = await fetch(origin + route, {
    method,
    redirect: "manual",
    headers: {
      Connection: "close",
      Cookie:
        cookie === undefined
          ? [...jar].map(([k, v]) => k + "=" + v).join("; ")
          : cookie,
      ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  cookies(r);
  return r;
}
async function begin() {
  const r = await request("/auth/login");
  assert.equal(r.status, 302, "login redirect missing");
  const u = new URL(r.headers.get("location"));
  assert.equal(u.origin, issuer);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("max_age"), "0");
  assert.equal(u.searchParams.get("redirect_uri"), origin + "/auth/callback");
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /Secure/);
  return u;
}
async function authorize(u) {
  const r = await fetch(u, { redirect: "manual" });
  assert.equal(r.status, 302);
  return new URL(r.headers.get("location"));
}
async function callback(u, opts) {
  return request(u.pathname + u.search, opts);
}
async function login(mode = "normal", sub = "owner") {
  responseMode = mode;
  subject = sub;
  return callback(await authorize(await begin()));
}
async function principal() {
  return (await request("/api/session")).json();
}
async function startWeb(port) {
  const app = createServer({
    store,
    archive: new LocalArchive(path.join(root, "archive")),
    origin,
    env: {
      SECURITY_OIDC_ISSUER: issuer,
      SECURITY_OIDC_CLIENT_ID: clientId,
      SECURITY_OIDC_CLIENT_SECRET: clientSecret,
    },
  });
  web = https.createServer(tls, app.listeners("request")[0]);
  await listen(web, port);
}
async function setup() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  store = new Store(root, { now: () => clock });
  provider = https.createServer(tls, async (req, res) => {
    try {
      const u = new URL(req.url, issuer || "https://fixture.invalid");
      if (u.pathname === "/.well-known/openid-configuration")
        return discoveryDown
          ? json(res, 503, { error: "temporarily_unavailable" })
          : json(res, 200, {
              issuer,
              authorization_endpoint: issuer + "/authorize",
              token_endpoint: issuer + "/token",
              jwks_uri: issuer + "/jwks",
              response_types_supported: ["code"],
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
              token_endpoint_auth_methods_supported: ["client_secret_post"],
              code_challenge_methods_supported: ["S256"],
              authorization_response_iss_parameter_supported: true,
            });
      if (u.pathname === "/jwks") {
        jwksReads++;
        return json(res, 200, { keys: [jwk] });
      }
      if (u.pathname === "/authorize") {
        assert.equal(u.searchParams.get("client_id"), clientId);
        assert.equal(
          u.searchParams.get("redirect_uri"),
          origin + "/auth/callback",
        );
        const code = crypto.randomBytes(24).toString("hex");
        codes.set(code, {
          nonce: u.searchParams.get("nonce"),
          challenge: u.searchParams.get("code_challenge"),
        });
        const back = new URL(origin + "/auth/callback");
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state"));
        back.searchParams.set("iss", issuer);
        res.writeHead(302, { Location: back.href });
        return res.end();
      }
      if (u.pathname === "/token") {
        tokenCalls++;
        let b = "";
        for await (const c of req) b += c;
        const params = new URLSearchParams(b);
        assert.equal(params.get("client_id"), clientId);
        assert.equal(params.get("client_secret"), clientSecret);
        assert.equal(params.get("redirect_uri"), origin + "/auth/callback");
        const record = codes.get(params.get("code"));
        codes.delete(params.get("code"));
        if (!record || responseMode === "token-error")
          return json(res, 400, { error: "invalid_grant" });
        const actual = crypto
          .createHash("sha256")
          .update(params.get("code_verifier") || "")
          .digest("base64url");
        if (responseMode === "pkce" || actual !== record.challenge)
          return json(res, 400, { error: "invalid_grant" });
        return json(res, 200, {
          access_token: "fixture-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: mint(record),
        });
      }
      return json(res, 404, { error: "not_found" });
    } catch {
      json(res, 500, { error: "fixture_assertion_failed" });
    }
  });
  issuer = "https://127.0.0.1:" + (await listen(provider));
  const reserve = net.createServer(),
    port = await listen(reserve);
  await close(reserve);
  origin = "https://127.0.0.1:" + port;
  for (const [sub, role] of [
    ["owner", "owner"],
    ["operator", "operator"],
    ["inspector", "inspector"],
  ])
    store.registerUser({
      id: issuer + "|" + sub,
      name: "Test " + sub,
      role,
      cameraIds: role === "owner" ? ["*"] : ["one"],
    });
  for (const id of ["one", "two"])
    store.put("cameras", id, { id, name: id, source: "recorder" });
  await startWeb(port);
}
async function execute() {
  await setup();
  if (scenario === "happy") {
    const r = await login();
    assert.equal(r.status, 302);
    assert.ok(jwksReads > 0, "JWT signing key was not checked");
    const cookieHeader = r.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-farber-session="));
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);
    assert.match(cookieHeader, /Secure/);
    assert.ok(!cookieHeader.includes("Domain="));
    const age = Number(/Max-Age=(\d+)/.exec(cookieHeader)[1]);
    assert.ok(age > 3500 && age <= 3600, "cookie outlives fixture identity");
    const oldCookie =
        "__Host-farber-session=" + jar.get("__Host-farber-session"),
      p = await principal();
    assert.equal(p.user.role, "owner");
    assert.ok(p.user.csrf);
    assert.equal(jar.has("__Host-farber-flow"), false);
    assert.equal((await request("/api/overview")).status, 200);
    assert.equal(
      (
        await request("/api/cameras", {
          method: "POST",
          body: { id: "one", name: "One", room: "Room", location: "Site" },
          headers: { "X-CSRF-Token": "wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/cameras", {
          method: "POST",
          body: { id: "one", name: "One", room: "Room", location: "Site" },
          headers: { "X-CSRF-Token": p.user.csrf },
        })
      ).status,
      201,
    );
    assert.equal((await login()).status, 302);
    assert.equal(
      (await request("/api/overview", { cookie: oldCookie })).status,
      401,
    );
    const latest = await principal();
    assert.equal(
      (
        await request("/api/logout", {
          method: "POST",
          body: {},
          headers: { "X-CSRF-Token": latest.user.csrf },
        })
      ).status,
      200,
    );
    assert.equal((await request("/api/overview")).status, 401);
    const persisted =
      JSON.stringify(store.db.prepare("SELECT * FROM sessions").all()) +
      JSON.stringify(store.auditLog());
    for (const value of [...issuedTokens, "fixture-access-token", clientSecret])
      assert.equal(persisted.includes(value), false);
  } else if (scenario === "claims") {
    for (const mode of [
      "signature",
      "issuer",
      "audience",
      "expired",
      "missing-auth-time",
      "stale-auth-time",
    ]) {
      const r = await login(mode);
      assert.notEqual(r.status, 302, mode + " was accepted");
      assert.equal((await principal()).user, null, mode);
      assert.equal(
        store.db
          .prepare(
            "SELECT count(*) AS n FROM sessions WHERE json_extract(data,'$.kind')='user'",
          )
          .get().n,
        0,
      );
    }
  } else if (scenario === "flow") {
    let u = await authorize(await begin()),
      calls = tokenCalls;
    u.searchParams.set("state", "wrong");
    assert.notEqual((await callback(u)).status, 302);
    assert.equal(tokenCalls, calls);
    u = await authorize(await begin());
    assert.equal((await callback(u, { cookie: "" })).status, 401);
    u = await authorize(await begin());
    const flowCookie = "__Host-farber-flow=" + jar.get("__Host-farber-flow");
    calls = tokenCalls;
    const concurrent = await Promise.all([
      callback(u, { cookie: flowCookie }),
      callback(u, { cookie: flowCookie }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [302, 401]);
    assert.equal(tokenCalls, calls + 1, "flow was consumed twice");
    assert.equal((await callback(u, { cookie: flowCookie })).status, 401);
    const sid = jar.get("__Host-farber-session");
    store.removeSession(sid);
    jar.clear();
    for (const mode of ["nonce", "pkce", "token-error"]) {
      assert.notEqual((await login(mode)).status, 302, mode);
      assert.equal((await principal()).user, null);
    }
    responseMode = "normal";
    u = await authorize(await begin());
    clock += 600001;
    assert.equal((await callback(u)).status, 401);
  } else if (scenario === "mfa-and-provisioning") {
    assert.equal((await login("no-mfa")).status, 403);
    assert.equal((await principal()).user, null);
    assert.equal((await login("normal", "not-provisioned")).status, 403);
    assert.equal((await login("no-mfa", "operator")).status, 302);
    assert.equal((await principal()).user.role, "operator");
    store.registerUser({
      id: issuer + "|operator",
      name: "Promoted",
      role: "owner",
      cameraIds: ["*"],
    });
    assert.equal(
      (await request("/api/overview")).status,
      401,
      "owner promotion reused non-MFA session",
    );
    assert.equal((await login("normal", "operator")).status, 302);
    store.registerUser({
      id: issuer + "|operator",
      name: "Disabled",
      role: "owner",
      cameraIds: ["*"],
      enabled: false,
    });
    assert.equal((await request("/api/overview")).status, 401);
    assert.equal((await login("normal", "operator")).status, 403);
  } else if (scenario === "restart-and-expiry") {
    assert.equal((await login()).status, 302);
    const sid = jar.get("__Host-farber-session"),
      p = await principal();
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM sessions WHERE id=?").get(sid)
        .n,
      0,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM sessions WHERE id=?")
        .get(digest(sid)).n,
      1,
    );
    const port = web.address().port;
    await close(web);
    web = null;
    store.close();
    store = new Store(root, { now: () => clock });
    await startWeb(port);
    assert.equal((await principal()).user.id, p.user.id);
    assert.equal((await request("/api/overview")).status, 200);
    const expires = store.db
      .prepare("SELECT expires FROM sessions WHERE id=?")
      .get(digest(sid)).expires;
    const claims = JSON.parse(
      Buffer.from(issuedTokens.at(-1).split(".")[1], "base64url"),
    );
    assert.equal(expires, claims.exp * 1000);
    // The issuer mints using wall time; setup can cross a second boundary.
    // Exercise the actual persisted/token expiry, not test-start + one hour.
    clock = expires - 1;
    assert.equal((await principal()).user.id, p.user.id);
    clock = expires;
    assert.equal((await principal()).user, null);
    assert.equal((await request("/api/overview")).status, 401);
  } else if (scenario === "inspector") {
    assert.equal((await login("normal", "inspector")).status, 302);
    assert.equal(
      (await (await request("/api/overview")).json()).cameras.length,
      0,
    );
    const admin = {
      id: issuer + "|owner",
      role: "owner",
      cameraIds: ["*"],
      mfa: true,
    };
    const g = store.grant(admin, {
      userId: issuer + "|inspector",
      cameraIds: ["one"],
      start: 100,
      end: 200,
      expiresAt: clock + 60000,
      requestId: "TEST-INSPECTION",
      purpose: "Fixture",
    });
    let o = await (await request("/api/overview")).json();
    assert.deepEqual(
      o.cameras.map((c) => c.id),
      ["one"],
    );
    assert.deepEqual(o.audit, []);
    assert.deepEqual(o.jobs, []);
    assert.equal(
      (await request("/api/timeline?camera=two&start=100&end=200")).status,
      403,
    );
    assert.equal(
      (await request("/api/timeline?camera=one&start=99&end=200")).status,
      403,
    );
    assert.equal(
      (await request("/api/timeline?camera=one&start=100&end=200")).status,
      200,
    );
    store.revoke(admin, g.id);
    assert.equal(
      (await request("/api/timeline?camera=one&start=100&end=200")).status,
      403,
    );
  } else if (scenario === "issuer-outage") {
    discoveryDown = true;
    assert.notEqual((await request("/auth/login")).status, 302);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM sessions").get().n,
      0,
    );
    discoveryDown = false;
    assert.equal((await login()).status, 302);
    assert.equal((await principal()).user.role, "owner");
  } else throw Error("Unknown fixture scenario");
}
execute()
  .then(() =>
    console.log(
      JSON.stringify({ scenario, passed: true, realAccountsUsed: false }),
    ),
  )
  .catch((e) => {
    console.error(
      JSON.stringify({ scenario, passed: false, error: e.message }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await close(web);
    await close(provider);
    store?.close();
  });
