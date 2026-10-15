"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Store } = require("../../security/server/store.cjs");
const { LocalArchive } = require("../../security/server/archive.cjs");
const { createServer } = require("../../security/server/http.cjs");
async function fixture(t, { review = false, anonymous = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-http-")),
    store = new Store(root),
    archive = new LocalArchive(path.join(root, "archive"));
  const owner = {
      id: "owner",
      name: "Test owner",
      role: "owner",
      cameraIds: ["*"],
      mfa: true,
      csrf: "fixture-csrf",
    },
    inspect = {
      id: "inspector",
      name: "Test inspector",
      role: "inspector",
      cameraIds: ["one"],
      csrf: "fixture-csrf",
    };
  store.registerUser(owner);
  store.registerUser(inspect);
  store.put("cameras", "one", {
    id: "one",
    name: "One",
    source: "recorder",
    location: "Test",
    room: "Test",
  });
  store.put("cameras", "secret", {
    id: "secret",
    name: "Secret",
    source: "recorder",
    providerId: "private-provider-reference",
    location: "Private",
    room: "Private",
  });
  const file = path.join(root, "source.mp4");
  fs.writeFileSync(file, "test-video-fixture");
  const sha = crypto
    .createHash("sha256")
    .update("test-video-fixture")
    .digest("hex");
  const receipt = await archive.put(file, sha, 18, Date.now() + 900000);
  fs.mkdirSync(path.join(root, "derivatives"));
  const id = "1".repeat(64);
  fs.writeFileSync(
    path.join(root, "derivatives", id + ".mp4"),
    "playback-fixture",
  );
  fs.writeFileSync(
    path.join(root, "derivatives", id + ".jpg"),
    "thumbnail-fixture",
  );
  store.put("segments", id, {
    id,
    cameraId: "one",
    source: "recorder",
    start: 100,
    end: 200,
    requested: { start: 100, end: 200 },
    verified: true,
    sha256: sha,
    bytes: 18,
    ingestedAt: Date.now(),
    provenance: "vendor-delivered",
    receipt,
    derivative: { video: id + ".mp4", image: id + ".jpg" },
  });
  // Use an ephemeral port allocated first; no test actor shortcut exists in CLI wiring.
  const reserve = require("node:net").createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer({
    store,
    archive,
    origin,
    review,
    env: {},
    ...(!review
      ? {
          authenticate: async (req) =>
            anonymous
              ? null
              : req.headers["x-test-actor"] === "inspector"
                ? inspect
                : owner,
        }
      : {}),
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    archive,
    owner,
    inspect,
    id,
    origin,
    call: (route, body, headers = {}) =>
      fetch(origin + route, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                Origin: origin,
                "X-CSRF-Token": "fixture-csrf",
              }
            : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  };
}
test("production gateway denies anonymous API/media and read-only loopback denies writes", async (t) => {
  const f = await fixture(t, { anonymous: true });
  assert.equal((await f.call("/api/overview")).status, 401);
  assert.equal((await f.call(`/api/media/${f.id}/playback`)).status, 401);
  const review = await fixture(t, { review: true });
  assert.equal((await review.call("/api/overview")).status, 200);
  assert.equal(
    (
      await review.call("/api/holds", {
        cameraId: "one",
        start: 100,
        end: 200,
        reason: "x",
        caseReference: "x",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await review.call("/api/overview", null, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
});
test("browser API connects records, named actions, exact byte ranges and signed evidence", async (t) => {
  const f = await fixture(t);
  let r = await f.call("/api/overview");
  assert.equal(r.status, 200);
  const overview = await r.json();
  assert.equal(overview.cameras[0].media.count, 1);
  assert.equal(
    JSON.stringify(overview).includes("private-provider-reference"),
    false,
  );
  r = await f.call(`/api/media/${f.id}/playback`, null, { Range: "bytes=0-3" });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 0-3/16");
  assert.equal(await r.text(), "play");
  assert.equal(
    (await f.call(`/api/media/${f.id}/playback`, null, { Range: "bytes=1-99" }))
      .status,
    416,
  );
  assert.equal((await f.call(`/api/media/${f.id}/original`)).status, 403);
  r = await f.call("/api/exports", {
    cameraId: "one",
    start: 100,
    end: 200,
    requestId: "FIXTURE",
    purpose: "Test handling chain",
  });
  assert.equal(r.status, 202);
  const exp = await r.json();
  assert.equal((await f.call(`/api/exports/${exp.id}`)).status, 409);
  await require("../../security/server/evidence.cjs").processEvidence(
    f.store,
    f.archive,
    f.store.claim(),
  );
  r = await f.call(`/api/exports/${exp.id}`);
  const signed = await r.json();
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(signed.manifestText),
      signed.publicKey,
      Buffer.from(signed.signature, "base64"),
    ),
    true,
  );
  r = await f.call(`/api/media/${f.id}/original?export=${exp.id}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "test-video-fixture");
  r = await f.call(
    "/api/records",
    {
      kind: "inspection",
      cameraIds: ["one"],
      performedAt: Date.now() - 1000,
      result: "incomplete",
      notes: "Fixture only",
      evidenceReference: "test",
    },
    { "X-CSRF-Token": "wrong" },
  );
  assert.equal(r.status, 403);
  assert.equal(f.store.all("records").length, 0);
});
test("inspector API omits unrelated cameras and rejects widened clip boundaries or revoked grants", async (t) => {
  const f = await fixture(t),
    headers = { "x-test-actor": "inspector" };
  let r = await f.call("/api/grants", {
    userId: f.inspect.id,
    cameraIds: ["one"],
    start: 101,
    end: 199,
    expiresAt: Date.now() + 60000,
    requestId: "LIMITED",
    purpose: "Test",
  });
  assert.equal(r.status, 201);
  let g = await r.json();
  r = await f.call("/api/overview", null, headers);
  const j = await r.json();
  assert.equal(j.cameras.length, 1);
  assert.equal(j.cameras[0].id, "one");
  assert.equal(j.cameras[0].media.count, 0);
  assert.equal(
    (await f.call(`/api/media/${f.id}/playback`, null, headers)).status,
    403,
  );
  await f.call("/api/grants/revoke", { id: g.id });
  g = f.store.grant(f.owner, {
    userId: f.inspect.id,
    cameraIds: ["one"],
    start: 100,
    end: 200,
    expiresAt: Date.now() + 60000,
    requestId: "FULL",
    purpose: "Test",
  });
  assert.equal(
    (await f.call(`/api/media/${f.id}/playback`, null, headers)).status,
    200,
  );
  f.store.revoke(f.owner, g.id);
  assert.equal(
    (await f.call(`/api/media/${f.id}/playback`, null, headers)).status,
    403,
  );
});
