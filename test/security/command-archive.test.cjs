"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { S3Archive } = require("../../security/server/archive.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-s3-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("original fixture"),
    file = path.join(root, "input.mp4");
  fs.writeFileSync(file, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex"),
    archive = new S3Archive({
      SECURITY_S3_BUCKET: "fixture-only",
      SECURITY_STORAGE_LOCK_APPROVED: "true",
    });
  t.after(() => archive.client.destroy());
  return { archive, bytes, file, sha };
}
test("S3 contract pins versions, verifies full bytes, extends retention, and confirms holds/deletion", async (t) => {
  const { archive, bytes, file, sha } = fixture(t);
  let head = null,
    held = false,
    deleted = false,
    puts = 0;
  const calls = [];
  archive.client.send = async (c) => {
    calls.push(c.constructor.name);
    const x = c.input;
    switch (c.constructor.name) {
      case "HeadObjectCommand":
        if (!head || deleted) throw { $metadata: { httpStatusCode: 404 } };
        return { ...head };
      case "PutObjectCommand":
        assert.equal(x.IfNoneMatch, "*");
        assert.equal(
          x.ChecksumSHA256,
          Buffer.from(sha, "hex").toString("base64"),
        );
        assert.equal(x.ObjectLockMode, "COMPLIANCE");
        for await (const _ of x.Body) {
        }
        puts++;
        head = {
          VersionId: "v1",
          ContentLength: bytes.length,
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: x.ObjectLockRetainUntilDate,
        };
        return { VersionId: "v1" };
      case "GetObjectCommand":
        assert.equal(x.VersionId, "v1");
        return { Body: Readable.from([bytes]) };
      case "PutObjectRetentionCommand":
        assert.equal(x.VersionId, "v1");
        head.ObjectLockRetainUntilDate = x.Retention.RetainUntilDate;
        return {};
      case "PutObjectLegalHoldCommand":
        assert.equal(x.VersionId, "v1");
        held = true;
        return {};
      case "GetObjectLegalHoldCommand":
        return { LegalHold: { Status: held ? "ON" : "OFF" } };
      case "DeleteObjectCommand":
        assert.equal(x.VersionId, "v1");
        deleted = true;
        return {};
      default:
        throw Error("Unexpected SDK command");
    }
  };
  const until = Date.now() + 86400000,
    r = await archive.put(file, sha, bytes.length, until);
  assert.equal(r.immutableStorageVerified, true);
  assert.equal(r.independent, true);
  assert.ok(r.readbackVerifiedAt);
  await archive.put(file, sha, bytes.length, until + 1000);
  assert.equal(puts, 1);
  assert.ok(calls.includes("PutObjectRetentionCommand"));
  await archive.setHold(r);
  assert.equal(held, true);
  await archive.remove(r);
  assert.equal(deleted, true);
});
test("S3 contract rejects unversioned buckets and corrupted readback", async (t) => {
  const { archive, bytes, file, sha } = fixture(t);
  archive.client.send = async () => ({
    VersionId: "null",
    ContentLength: bytes.length,
  });
  await assert.rejects(
    archive.put(file, sha, bytes.length, Date.now()),
    /VERSIONED/,
  );
  archive.client.send = async (c) =>
    c.constructor.name === "HeadObjectCommand"
      ? {
          VersionId: "v1",
          ContentLength: bytes.length,
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: new Date(Date.now() + 900000),
        }
      : { Body: Readable.from([Buffer.from("altered")]) };
  await assert.rejects(
    archive.put(file, sha, bytes.length, Date.now()),
    /READBACK/,
  );
});
