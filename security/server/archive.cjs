"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { hashFile } = require("../../lib/security/ring-pilot.cjs");
const { error } = require("./store.cjs");
async function inspectBytes(read, r, { timeoutMs = 120000 } = {}) {
  const checkedAt = Date.now();
  if (
    !r ||
    !/^[a-f0-9]{64}$/.test(r.sha256 || "") ||
    !Number.isSafeInteger(r.size) ||
    r.size < 1
  )
    return { state: "unavailable", code: "ARCHIVE_RECEIPT_INVALID", checkedAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  let stream, onAbort;
  try {
    stream = await read(r, { signal: controller.signal });
    onAbort = () => stream.destroy?.(error("ARCHIVE_READBACK_TIMEOUT", 503));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) throw error("ARCHIVE_READBACK_TIMEOUT", 503);
    const h = crypto.createHash("sha256");
    let bytes = 0;
    for await (const c of stream) {
      bytes += c.length;
      if (bytes > r.size)
        return {
          state: "mismatch",
          code: "ARCHIVE_SIZE_MISMATCH",
          checkedAt: Date.now(),
        };
      h.update(c);
    }
    return bytes === r.size && h.digest("hex") === r.sha256
      ? { state: "verified", code: null, checkedAt: Date.now() }
      : {
          state: "mismatch",
          code: "ARCHIVE_READBACK_MISMATCH",
          checkedAt: Date.now(),
        };
  } catch (e) {
    const missing = e.code === "ENOENT" || e.$metadata?.httpStatusCode === 404;
    return {
      state: missing ? "missing" : "unavailable",
      code: missing
        ? "ARCHIVE_OBJECT_MISSING"
        : controller.signal.aborted
          ? "ARCHIVE_READBACK_TIMEOUT"
          : "ARCHIVE_READBACK_UNAVAILABLE",
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    stream?.destroy?.();
  }
}
function keyFor(sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw error("INVALID_HASH");
  return `originals/${sha.slice(0, 2)}/${sha}.mp4`;
}
class LocalArchive {
  constructor(root) {
    this.root = path.resolve(root);
    this.independent = false;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  file(key) {
    if (!/^originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.mp4$/.test(key))
      throw error("INVALID_OBJECT_KEY");
    return path.join(this.root, key);
  }
  async put(file, sha, size, retainUntil, { beforeWrite = () => {} } = {}) {
    const key = keyFor(sha),
      dest = this.file(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = dest + "." + crypto.randomUUID() + ".part";
    try {
      await pipeline(
        fs.createReadStream(file),
        new Transform({
          transform(chunk, encoding, done) {
            try {
              beforeWrite(chunk.length);
              done(null, chunk);
            } catch (e) {
              done(e);
            }
          },
        }),
        fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
      );
      const fd = fs.openSync(tmp, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if ((await hashFile(tmp)) !== sha) throw error("UPLOAD_HASH_MISMATCH");
      try {
        fs.linkSync(tmp, dest);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      if ((await hashFile(dest)) !== sha || fs.statSync(dest).size !== size)
        throw error("ARCHIVE_READBACK_MISMATCH");
      const d = fs.openSync(path.dirname(dest), "r");
      fs.fsyncSync(d);
      fs.closeSync(d);
      return {
        objectKey: key,
        versionId: sha,
        sha256: sha,
        size,
        readbackVerifiedAt: Date.now(),
        retainUntil,
        independent: false,
        immutableStorageVerified: false,
        retentionMode: "none",
      };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  async verify(r) {
    return (await this.inspect(r)).state === "verified";
  }
  async inspect(r, options) {
    return inspectBytes(this.read.bind(this), r, options);
  }
  async read(r, { signal } = {}) {
    return fs.createReadStream(this.file(r.objectKey), { signal });
  }
  async setHold() {
    throw error("INDEPENDENT_OBJECT_HOLD_NOT_CONFIGURED", 409);
  }
  async verifyProtection() {
    return false;
  }
  async remove() {
    throw error("LOCAL_REVIEW_DELETION_DISABLED", 409);
  }
}
class S3Archive {
  constructor(env) {
    const sdk = require("@aws-sdk/client-s3");
    this.sdk = sdk;
    this.bucket = env.SECURITY_S3_BUCKET;
    if (!this.bucket) throw error("ARCHIVE_BUCKET_REQUIRED");
    if (
      env.SECURITY_S3_ENDPOINT &&
      new URL(env.SECURITY_S3_ENDPOINT).protocol !== "https:"
    )
      throw error("ARCHIVE_HTTPS_REQUIRED");
    this.client = new sdk.S3Client({
      region: env.SECURITY_S3_REGION || "us-east-1",
      ...(env.SECURITY_S3_ENDPOINT
        ? { endpoint: env.SECURITY_S3_ENDPOINT }
        : {}),
      forcePathStyle: env.SECURITY_S3_PATH_STYLE === "true",
      maxAttempts: 3,
    });
    this.lockApproved = env.SECURITY_STORAGE_LOCK_APPROVED === "true";
    this.independent = true;
  }
  async put(file, sha, size, retainUntil) {
    const { PutObjectCommand, HeadObjectCommand } = this.sdk;
    const Key = keyFor(sha);
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key,
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (e) {
      if (![404].includes(e.$metadata?.httpStatusCode))
        throw error("ARCHIVE_HEAD_FAILED", 502);
    }
    if (!head) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key,
            Body: fs.createReadStream(file),
            ContentLength: size,
            ContentType: "video/mp4",
            ChecksumSHA256: Buffer.from(sha, "hex").toString("base64"),
            IfNoneMatch: "*",
            ServerSideEncryption: "AES256",
            ...(this.lockApproved
              ? {
                  ObjectLockMode: "COMPLIANCE",
                  ObjectLockRetainUntilDate: new Date(retainUntil),
                }
              : {}),
          }),
        );
      } catch (e) {
        if (e.$metadata?.httpStatusCode !== 412)
          throw error("ARCHIVE_UPLOAD_FAILED", 502);
      }
      head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key,
          ChecksumMode: "ENABLED",
        }),
      );
    }
    if (
      !head.VersionId ||
      head.VersionId === "null" ||
      head.ContentLength !== size
    )
      throw error("VERSIONED_ARCHIVE_REQUIRED", 409);
    if (
      this.lockApproved &&
      (head.ObjectLockMode !== "COMPLIANCE" ||
        !head.ObjectLockRetainUntilDate ||
        head.ObjectLockRetainUntilDate.getTime() < retainUntil)
    ) {
      await this.client.send(
        new this.sdk.PutObjectRetentionCommand({
          Bucket: this.bucket,
          Key,
          VersionId: head.VersionId,
          Retention: {
            Mode: "COMPLIANCE",
            RetainUntilDate: new Date(
              Math.max(
                retainUntil,
                head.ObjectLockRetainUntilDate?.getTime() || 0,
              ),
            ),
          },
        }),
      );
      head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key,
          VersionId: head.VersionId,
          ChecksumMode: "ENABLED",
        }),
      );
    }
    const r = {
      objectKey: Key,
      versionId: head.VersionId,
      sha256: sha,
      size,
      readbackVerifiedAt: null,
      retainUntil: head.ObjectLockRetainUntilDate?.getTime() || 0,
      independent: true,
      immutableStorageVerified:
        head.ObjectLockMode === "COMPLIANCE" &&
        head.ObjectLockRetainUntilDate?.getTime() >= retainUntil,
      retentionMode: head.ObjectLockMode?.toLowerCase() || "none",
    };
    if (!(await this.verify(r))) throw error("ARCHIVE_READBACK_MISMATCH", 502);
    r.readbackVerifiedAt = Date.now();
    return r;
  }
  async read(r, { signal } = {}) {
    const out = await this.client.send(
      new this.sdk.GetObjectCommand({
        Bucket: this.bucket,
        Key: r.objectKey,
        VersionId: r.versionId,
      }),
      { abortSignal: signal },
    );
    return out.Body;
  }
  async verify(r) {
    return (await this.inspect(r)).state === "verified";
  }
  async inspect(r, options) {
    return inspectBytes(this.read.bind(this), r, options);
  }
  async setHold(r) {
    await this.client.send(
      new this.sdk.PutObjectLegalHoldCommand({
        Bucket: this.bucket,
        Key: r.objectKey,
        VersionId: r.versionId,
        LegalHold: { Status: "ON" },
      }),
    );
    const out = await this.client.send(
      new this.sdk.GetObjectLegalHoldCommand({
        Bucket: this.bucket,
        Key: r.objectKey,
        VersionId: r.versionId,
      }),
    );
    if (out.LegalHold?.Status !== "ON")
      throw error("HOLD_READBACK_FAILED", 502);
    return true;
  }
  async verifyProtection(r, minimumUntil) {
    if (
      !this.lockApproved ||
      !r?.independent ||
      !r.immutableStorageVerified ||
      !r.versionId ||
      r.versionId === "null" ||
      !Number.isSafeInteger(minimumUntil)
    )
      return false;
    try {
      const head = await this.client.send(
        new this.sdk.HeadObjectCommand({
          Bucket: this.bucket,
          Key: r.objectKey,
          VersionId: r.versionId,
          ChecksumMode: "ENABLED",
        }),
      );
      return (
        head.VersionId === r.versionId &&
        head.ContentLength === r.size &&
        head.ObjectLockMode === "COMPLIANCE" &&
        head.ObjectLockRetainUntilDate?.getTime() >= minimumUntil
      );
    } catch {
      return false;
    }
  }
  async remove(r) {
    await this.client.send(
      new this.sdk.DeleteObjectCommand({
        Bucket: this.bucket,
        Key: r.objectKey,
        VersionId: r.versionId,
      }),
    );
    try {
      await this.client.send(
        new this.sdk.HeadObjectCommand({
          Bucket: this.bucket,
          Key: r.objectKey,
          VersionId: r.versionId,
        }),
      );
      throw error("DELETE_NOT_CONFIRMED", 502);
    } catch (e) {
      if (e.$metadata?.httpStatusCode !== 404)
        throw error("DELETE_NOT_CONFIRMED", 502);
    }
  }
}
function archiveFor(env, root) {
  return env.SECURITY_S3_BUCKET
    ? new S3Archive(env)
    : new LocalArchive(path.join(root, "archive"));
}
module.exports = { LocalArchive, S3Archive, archiveFor, keyFor, inspectBytes };
