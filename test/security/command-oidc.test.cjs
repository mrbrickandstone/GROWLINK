"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { spawnSync } = require("node:child_process");
let root, cert, key;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-oidc-"));
  cert = path.join(root, "cert.pem");
  key = path.join(root, "key.pem");
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
  assert.equal(made.status, 0, "Could not create private TLS fixture");
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
for (const [scenario, description] of [
  [
    "happy",
    "real OIDC login enforces PKCE, signed identity, secure session rotation, CSRF and logout",
  ],
  [
    "claims",
    "real OIDC callback rejects invalid signatures, issuer/audience, expiry and missing/stale authentication time",
  ],
  [
    "flow",
    "OIDC state, nonce, PKCE, expired flow and replay protections work through HTTPS callbacks",
  ],
  [
    "mfa-and-provisioning",
    "OIDC claims cannot grant roles, owner MFA is required and live disable/promotion revokes access",
  ],
  [
    "restart-and-expiry",
    "hashed OIDC sessions survive a web restart but expire with the identity token",
  ],
  [
    "inspector",
    "an OIDC inspector still needs a request-specific grant and immediate revocation takes effect",
  ],
  [
    "issuer-outage",
    "failed issuer discovery grants no session and a later fresh attempt recovers",
  ],
])
  test(description, { timeout: 30000 }, () => {
    const run = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, "oidc-flow.drill.cjs"),
        scenario,
        path.join(root, scenario),
        cert,
        key,
      ],
      {
        env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert },
        encoding: "utf8",
        timeout: 25000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).passed, true);
  });
