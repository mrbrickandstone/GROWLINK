"use strict";
// Explicit, supervised checks of an existing dedicated test bucket. No real footage.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { S3Archive, keyFor } = require("../server/archive.cjs");
const HOUR = 3600000,
  DAY = 24 * HOUR;
const files = [
  "probe-unlocked.json",
  "probe-locked.json",
  "probe-checksum.json",
];
const keys = [
  "SECURITY_S3_BUCKET",
  "SECURITY_S3_REGION",
  "SECURITY_S3_ENDPOINT",
  "SECURITY_S3_PATH_STYLE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];
const EFFECTS = [
  "Read bucket versioning, Object Lock configuration and ACL",
  "Upload only these three generated test bodies; one upload must be rejected for a wrong checksum",
  "Test conditional upload, create two different synthetic versions of the unlocked key, verify each pinned version and delete those exact unlocked versions",
  "Lock one tiny synthetic object in COMPLIANCE for 25 hours, extend by one minute, apply then release its test-only legal hold, and attempt forbidden shortening/deletion",
  "Leave locked bytes and any unexpected versions in place for reviewed follow-up; create no bucket, account, lifecycle rule or real-footage export",
];
function fail(code) {
  throw Error(code);
}
const safeCodes = new Set([
  "PRIVATE_ARCHIVE_CHECK_FILE_REQUIRED",
  "ABSOLUTE_ARCHIVE_CHECK_PATH_REQUIRED",
  "PRIVATE_ARCHIVE_CHECK_DIRECTORY_REQUIRED",
  "PRIVATE_ARCHIVE_CHECK_CONFIG_INVALID",
  "ARCHIVE_CHECK_PLAN_INVALID_OR_EXPIRED",
  "ARCHIVE_CHECK_SYNTHETIC_BODY_REQUIRED",
  "SYNTHETIC_LOCK_APPROVAL_REFERENCE_REQUIRED",
  "USE_PLAN_OR_RUN_WITH_PRIVATE_CONFIG_AND_NEW_RUN_DIRECTORY",
  "EXPECTED_DENIAL_NOT_OBSERVED",
  "FORBIDDEN_OPERATION_SUCCEEDED",
  "BUCKET_VERSIONING_REQUIRED",
  "TEST_BUCKET_LOCK_WITHOUT_DEFAULT_RETENTION_REQUIRED",
  "PRIVATE_TEST_BUCKET_ACL_REQUIRED",
  "UNLOCKED_ENCRYPTED_VERSION_REQUIRED",
  "IDEMPOTENT_VERSION_CHANGED",
  "UNEXPECTED_TEST_OBJECT_VERSIONS",
  "COMPLIANCE_PROTECTION_NOT_VERIFIED",
  "RETENTION_EXTENSION_NOT_VERIFIED",
  "TEST_HOLD_RELEASE_NOT_VERIFIED",
  "LOCKED_ORIGINAL_NOT_PRESERVED",
  "PINNED_VERSION_READ_OR_DELETE_FAILED",
  "ARCHIVE_HEAD_FAILED",
  "ARCHIVE_UPLOAD_FAILED",
  "VERSIONED_ARCHIVE_REQUIRED",
  "ARCHIVE_READBACK_MISMATCH",
  "HOLD_READBACK_FAILED",
  "ARCHIVE_DELETE_NOT_CONFIRMED",
]);
const safeCode = (e) =>
  safeCodes.has(e?.message) ? e.message : "ARCHIVE_CONTRACT_FAILED";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function privateRead(file, max = 32768) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.mode & 0o077 ||
      st.size > max ||
      ![0, process.getuid()].includes(st.uid)
    )
      fail("PRIVATE_ARCHIVE_CHECK_FILE_REQUIRED");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function privateRoot(root) {
  if (!path.isAbsolute(root)) fail("ABSOLUTE_ARCHIVE_CHECK_PATH_REQUIRED");
  const st = fs.lstatSync(root);
  if (
    !st.isDirectory() ||
    st.mode & 0o077 ||
    ![0, process.getuid()].includes(st.uid)
  )
    fail("PRIVATE_ARCHIVE_CHECK_DIRECTORY_REQUIRED");
  return fs.realpathSync(root);
}
function write(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function readConfig(file) {
  try {
    const c = JSON.parse(privateRead(file));
    if (
      !c ||
      Array.isArray(c) ||
      Object.entries(c).some(
        ([k, v]) =>
          !keys.includes(k) || typeof v !== "string" || v.includes("\0"),
      ) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.SECURITY_S3_BUCKET || "") ||
      !c.SECURITY_S3_REGION ||
      !c.AWS_ACCESS_KEY_ID ||
      !c.AWS_SECRET_ACCESS_KEY ||
      (c.SECURITY_S3_PATH_STYLE &&
        !["true", "false"].includes(c.SECURITY_S3_PATH_STYLE))
    )
      throw Error();
    if (c.SECURITY_S3_ENDPOINT) {
      const u = new URL(c.SECURITY_S3_ENDPOINT);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        throw Error();
    }
    return c;
  } catch {
    fail("PRIVATE_ARCHIVE_CHECK_CONFIG_INVALID");
  }
}
function target(c) {
  return {
    bucket: c.SECURITY_S3_BUCKET,
    region: c.SECURITY_S3_REGION,
    endpoint: c.SECURITY_S3_ENDPOINT || null,
    pathStyle: c.SECURITY_S3_PATH_STYLE === "true",
  };
}
const binding = (c) => hash(JSON.stringify(target(c)));
function prepare(config, destination, { now = Date.now() } = {}) {
  if (!path.isAbsolute(destination))
    fail("ABSOLUTE_ARCHIVE_CHECK_PATH_REQUIRED");
  fs.mkdirSync(destination, { mode: 0o700 });
  const root = privateRoot(destination),
    runId = crypto.randomUUID();
  const objects = files.map((file, index) => {
    const bytes = Buffer.from(
      JSON.stringify({
        type: "farber-synthetic-archive-check-v1",
        runId,
        probe: index,
        nonce: crypto.randomBytes(32).toString("hex"),
      }) + "\n",
    );
    write(path.join(root, file), bytes);
    const sha256 = hash(bytes);
    return { file, sha256, bytes: bytes.length, objectKey: keyFor(sha256) };
  });
  const plan = {
    schema: "farber-archive-check-v1",
    runId,
    target: target(config),
    configurationHash: binding(config),
    preparedAt: now,
    expiresAt: now + HOUR / 2,
    retainUntil: now + 25 * HOUR,
    objects,
    effects: EFFECTS,
    sourceFootageIncluded: false,
    purchasesAuthorized: false,
  };
  write(path.join(root, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return plan;
}
function loadPlan(config, directory, now) {
  const root = privateRoot(directory),
    plan = JSON.parse(privateRead(path.join(root, "plan.json")));
  if (
    plan.schema !== "farber-archive-check-v1" ||
    !/^[a-f0-9-]{36}$/.test(plan.runId || "") ||
    plan.configurationHash !== binding(config) ||
    JSON.stringify(plan.target) !== JSON.stringify(target(config)) ||
    JSON.stringify(plan.effects) !== JSON.stringify(EFFECTS) ||
    plan.sourceFootageIncluded !== false ||
    plan.purchasesAuthorized !== false ||
    !Number.isSafeInteger(plan.preparedAt) ||
    plan.preparedAt > now ||
    plan.expiresAt !== plan.preparedAt + HOUR / 2 ||
    now > plan.expiresAt ||
    plan.retainUntil !== plan.preparedAt + 25 * HOUR ||
    plan.retainUntil - now < DAY ||
    !Array.isArray(plan.objects) ||
    plan.objects.length !== files.length
  )
    fail("ARCHIVE_CHECK_PLAN_INVALID_OR_EXPIRED");
  for (let i = 0; i < files.length; i++) {
    const o = plan.objects[i];
    if (o.file !== files[i]) fail("ARCHIVE_CHECK_SYNTHETIC_BODY_REQUIRED");
    const bytes = privateRead(path.join(root, o.file), 1024),
      body = JSON.parse(bytes);
    if (
      body.type !== "farber-synthetic-archive-check-v1" ||
      body.runId !== plan.runId ||
      body.probe !== i ||
      !/^[a-f0-9]{64}$/.test(body.nonce || "") ||
      JSON.stringify(Object.keys(body)) !==
        JSON.stringify(["type", "runId", "probe", "nonce"]) ||
      hash(bytes) !== o.sha256 ||
      bytes.length !== o.bytes ||
      o.objectKey !== keyFor(o.sha256)
    )
      fail("ARCHIVE_CHECK_SYNTHETIC_BODY_REQUIRED");
  }
  return { root, plan };
}
async function run(
  config,
  directory,
  approvalReference,
  { now = Date.now, createArchive } = {},
) {
  if (
    typeof approvalReference !== "string" ||
    !approvalReference.trim() ||
    approvalReference.length > 200
  )
    fail("SYNTHETIC_LOCK_APPROVAL_REFERENCE_REQUIRED");
  const { root, plan } = loadPlan(config, directory, now());
  // One attempt per plan, including crash/unknown outcomes: never blindly replay.
  write(
    path.join(root, "RUN_STARTED"),
    JSON.stringify({ at: now(), approvalReference }) + "\n",
  );
  const report = {
    schema: "farber-archive-check-result-v1",
    runId: plan.runId,
    configurationHash: binding(config),
    startedAt: now(),
    approvalReference,
    contractChecksPassed: false,
    qualificationPassed: false,
    steps: [],
    objects: plan.objects.map((o) => ({
      objectKey: o.objectKey,
      sha256: o.sha256,
      bytes: o.bytes,
      versions: [],
    })),
    sourceFootageIncluded: false,
    unresolved: [
      "Effective bucket privacy including policy/access paths",
      "Deletion after COMPLIANCE retention expiry",
      "Live workload/cost and crash/reconciliation behavior",
      "Independent storage/credential custody",
      "Ring/vendor/site-policy acceptance",
    ],
  };
  let archive;
  const save = () => {
    const tmp = path.join(root, "result.json.part");
    write(tmp, JSON.stringify(report, null, 2) + "\n");
    fs.renameSync(tmp, path.join(root, "result.json"));
    const fd = fs.openSync(root, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  save();
  const step = async (name, fn) => {
    const row = { name, startedAt: now(), state: "running" };
    report.steps.push(row);
    save();
    try {
      await fn();
      row.state = "passed";
    } catch (e) {
      row.state = "failed";
      row.code = safeCode(e);
      throw e;
    } finally {
      row.completedAt = now();
      save();
    }
  };
  try {
    archive = createArchive
      ? createArchive(config)
      : new S3Archive(config, {
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
            ...(config.AWS_SESSION_TOKEN
              ? { sessionToken: config.AWS_SESSION_TOKEN }
              : {}),
          },
        });
    const send = archive.client.send.bind(archive.client);
    archive.client.send = (command, opts = {}) =>
      send(command, {
        ...opts,
        abortSignal: opts.abortSignal || AbortSignal.timeout(30000),
      });
    const sdk = archive.sdk,
      Bucket = archive.bucket;
    const call = (name, input) =>
      archive.client.send(new sdk[name]({ Bucket, ...input }));
    const denied = async (name, input, status, expectedCode) => {
      try {
        await call(name, input);
      } catch (e) {
        if (
          e.$metadata?.httpStatusCode === status &&
          (!expectedCode || [e.name, e.Code, e.code].includes(expectedCode))
        )
          return;
        throw Error("EXPECTED_DENIAL_NOT_OBSERVED");
      }
      fail("FORBIDDEN_OPERATION_SUCCEEDED");
    };
    await step("dedicated-test-bucket-preflight", async () => {
      const v = await call("GetBucketVersioningCommand", {}),
        l = await call("GetObjectLockConfigurationCommand", {}),
        a = await call("GetBucketAclCommand", {});
      if (v.Status !== "Enabled") fail("BUCKET_VERSIONING_REQUIRED");
      if (
        l.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled" ||
        l.ObjectLockConfiguration?.Rule?.DefaultRetention
      )
        fail("TEST_BUCKET_LOCK_WITHOUT_DEFAULT_RETENTION_REQUIRED");
      if (
        !a.Owner?.ID ||
        !Array.isArray(a.Grants) ||
        a.Grants.some(
          (g) =>
            g.Grantee?.Type !== "CanonicalUser" || g.Grantee?.ID !== a.Owner.ID,
        )
      )
        fail("PRIVATE_TEST_BUCKET_ACL_REQUIRED");
      for (const o of plan.objects)
        await denied("HeadObjectCommand", { Key: o.objectKey }, 404);
    });
    let plain, alternate, locked;
    const upload = async (index, lock, until) => {
      archive.lockApproved = lock;
      const o = plan.objects[index];
      return archive.put(path.join(root, o.file), o.sha256, o.bytes, until);
    };
    await step("unlocked-upload-and-full-readback", async () => {
      plain = await upload(0, false, 0);
      report.objects[0].receipt = plain;
      const h = await call("HeadObjectCommand", {
        Key: plain.objectKey,
        VersionId: plain.versionId,
        ChecksumMode: "ENABLED",
      });
      if (
        h.VersionId !== plain.versionId ||
        h.ServerSideEncryption !== "AES256" ||
        h.ObjectLockRetainUntilDate?.getTime() > now()
      )
        fail("UNLOCKED_ENCRYPTED_VERSION_REQUIRED");
    });
    await step("idempotent-upload-and-conditional-write", async () => {
      const again = await upload(0, false, 0);
      if (again.versionId !== plain.versionId)
        fail("IDEMPOTENT_VERSION_CHANGED");
      const o = plan.objects[0];
      await denied(
        "PutObjectCommand",
        {
          Key: o.objectKey,
          Body: privateRead(path.join(root, o.file)),
          ContentLength: o.bytes,
          ChecksumSHA256: Buffer.from(o.sha256, "hex").toString("base64"),
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
        },
        412,
      );
      const versions = await call("ListObjectVersionsCommand", {
        Prefix: o.objectKey,
        MaxKeys: 1000,
      });
      if (
        versions.IsTruncated ||
        versions.Versions?.filter((v) => v.Key === o.objectKey).length !== 1 ||
        versions.DeleteMarkers?.some((v) => v.Key === o.objectKey)
      )
        fail("UNEXPECTED_TEST_OBJECT_VERSIONS");
    });
    await step("wrong-upload-checksum-rejected", async () => {
      const o = plan.objects[2];
      await denied(
        "PutObjectCommand",
        {
          Key: o.objectKey,
          Body: privateRead(path.join(root, o.file)),
          ContentLength: o.bytes,
          ChecksumSHA256: Buffer.alloc(32).toString("base64"),
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
        },
        400,
        "BadDigest",
      );
      await denied("HeadObjectCommand", { Key: o.objectKey }, 404);
    });
    await step("version-pinning-with-different-latest-bytes", async () => {
      const o = plan.objects[2];
      const uploaded = await call("PutObjectCommand", {
        Key: plain.objectKey,
        Body: privateRead(path.join(root, o.file)),
        ContentLength: o.bytes,
        ContentType: "video/mp4",
        ChecksumSHA256: Buffer.from(o.sha256, "hex").toString("base64"),
        ServerSideEncryption: "AES256",
      });
      if (
        !uploaded.VersionId ||
        uploaded.VersionId === "null" ||
        uploaded.VersionId === plain.versionId
      )
        fail("PINNED_VERSION_READ_OR_DELETE_FAILED");
      alternate = {
        ...plain,
        versionId: uploaded.VersionId,
        sha256: o.sha256,
        size: o.bytes,
      };
      report.objects[0].alternateReceipt = alternate;
      const latest = await call("HeadObjectCommand", { Key: plain.objectKey });
      if (
        latest.VersionId !== alternate.versionId ||
        !(await archive.verify(plain)) ||
        !(await archive.verify(alternate))
      )
        fail("PINNED_VERSION_READ_OR_DELETE_FAILED");
    });
    await step("unlocked-exact-version-deletion", async () => {
      await archive.remove(plain);
      if (!(await archive.verify(alternate)))
        fail("PINNED_VERSION_READ_OR_DELETE_FAILED");
      await archive.remove(alternate);
    });
    await step("compliance-upload-and-retention-extension", async () => {
      locked = await upload(1, true, plan.retainUntil);
      report.objects[1].receipt = locked;
      if (!locked.immutableStorageVerified)
        fail("COMPLIANCE_PROTECTION_NOT_VERIFIED");
      const extended = await upload(1, true, plan.retainUntil + 60000);
      if (
        extended.versionId !== locked.versionId ||
        !(await archive.verifyProtection(extended, plan.retainUntil + 60000))
      )
        fail("RETENTION_EXTENSION_NOT_VERIFIED");
      locked = extended;
      report.objects[1].receipt = locked;
    });
    await step("test-only-legal-hold-apply-and-release", async () => {
      await archive.setHold(locked);
      await denied(
        "DeleteObjectCommand",
        { Key: locked.objectKey, VersionId: locked.versionId },
        403,
      );
      await call("PutObjectLegalHoldCommand", {
        Key: locked.objectKey,
        VersionId: locked.versionId,
        LegalHold: { Status: "OFF" },
      });
      const h = await call("GetObjectLegalHoldCommand", {
        Key: locked.objectKey,
        VersionId: locked.versionId,
      });
      if (h.LegalHold?.Status !== "OFF") fail("TEST_HOLD_RELEASE_NOT_VERIFIED");
    });
    await step("compliance-alone-rejects-shortening-and-deletion", async () => {
      await denied(
        "PutObjectRetentionCommand",
        {
          Key: locked.objectKey,
          VersionId: locked.versionId,
          Retention: {
            Mode: "COMPLIANCE",
            RetainUntilDate: new Date(now() + HOUR),
          },
        },
        403,
      );
      await denied(
        "DeleteObjectCommand",
        { Key: locked.objectKey, VersionId: locked.versionId },
        403,
      );
      if (
        !(await archive.verifyProtection(locked, plan.retainUntil + 60000)) ||
        !(await archive.verify(locked))
      )
        fail("LOCKED_ORIGINAL_NOT_PRESERVED");
    });
    report.contractChecksPassed = true;
  } catch (e) {
    report.error = safeCode(e);
  } finally {
    if (archive) {
      for (const o of report.objects)
        try {
          const v = await archive.client.send(
            new archive.sdk.ListObjectVersionsCommand({
              Bucket: archive.bucket,
              Prefix: o.objectKey,
              MaxKeys: 1000,
            }),
          );
          o.versions = (v.Versions || [])
            .filter((v) => v.Key === o.objectKey)
            .map((v) => ({ versionId: v.VersionId, size: v.Size }));
          o.inventoryComplete = !v.IsTruncated;
          o.deleteMarkers = (v.DeleteMarkers || [])
            .filter((v) => v.Key === o.objectKey)
            .map((v) => v.VersionId);
        } catch {
          o.inventoryComplete = false;
        }
      archive.client.destroy();
    }
    if (
      report.contractChecksPassed &&
      (report.objects.some(
        (o) => !o.inventoryComplete || o.deleteMarkers?.length,
      ) ||
        report.objects[0].versions.length ||
        report.objects[2].versions.length ||
        report.objects[1].versions.length !== 1 ||
        report.objects[1].versions[0].versionId !==
          report.objects[1].receipt?.versionId)
    ) {
      report.contractChecksPassed = false;
      report.error = "FINAL_TEST_INVENTORY_UNVERIFIED";
    }
    report.completedAt = now();
    save();
  }
  return report;
}
if (require.main === module) {
  process.umask(0o077);
  (async () => {
    const [command, file, root, approval, ...extra] = process.argv.slice(2);
    if (extra.length || !file || !root)
      fail("USE_PLAN_OR_RUN_WITH_PRIVATE_CONFIG_AND_NEW_RUN_DIRECTORY");
    const config = readConfig(file);
    if (command === "plan" && !approval) {
      const p = prepare(config, root);
      console.log(
        JSON.stringify({
          prepared: true,
          networkRequests: 0,
          objects: p.objects.length,
          totalBytes: p.objects.reduce((n, o) => n + o.bytes, 0),
          expiresAt: p.expiresAt,
          retentionUntil: p.retainUntil,
        }),
      );
    } else if (command === "run" && approval) {
      const r = await run(config, root, approval);
      console.log(
        JSON.stringify({
          contractChecksPassed: r.contractChecksPassed,
          qualificationPassed: false,
          steps: r.steps.map((s) => ({
            name: s.name,
            state: s.state,
            code: s.code,
          })),
          reviewResultFile: true,
        }),
      );
      if (!r.contractChecksPassed) process.exitCode = 2;
    } else fail("USE_PLAN_OR_RUN_WITH_PRIVATE_CONFIG_AND_NEW_RUN_DIRECTORY");
  })().catch((e) => {
    console.error(safeCode(e));
    process.exitCode = 1;
  });
}
module.exports = { readConfig, prepare, run };
