"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { Readable } = require("node:stream"),
  { spawn, spawnSync } = require("node:child_process"),
  { once } = require("node:events");
const { S3Archive } = require("../../security/server/archive.cjs");
const {
  readConfig,
  prepare,
  run,
} = require("../../security/deploy/check-archive.cjs");
const config = {
  SECURITY_S3_BUCKET: "synthetic-qualification-fixture",
  SECURITY_S3_REGION: "us-east-1",
  SECURITY_S3_ENDPOINT: "https://fixture.example.invalid",
  AWS_ACCESS_KEY_ID: "FIXTUREACCESSKEYONLY",
  AWS_SECRET_ACCESS_KEY: "FIXTURESECRETNEVERPRINT",
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farber-provider-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, now: Date.now(), directory: path.join(root, "run") };
}
function fake(mode, now) {
  const a = new S3Archive(config, {
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    }),
    objects = new Map(),
    calls = [];
  let sequence = 0;
  const reject = (status, name = "AccessDenied") => {
    const e = Error("PRIVATE_PROVIDER_DETAIL");
    e.name = name;
    e.$metadata = { httpStatusCode: status };
    throw e;
  };
  a.client.send = async (command, opts) => {
    const name = command.constructor.name,
      x = command.input;
    calls.push({ name, input: x });
    assert.ok(opts.abortSignal);
    assert.equal(x.Bucket, config.SECURITY_S3_BUCKET);
    if (mode === "provider-secret") throw Error(config.AWS_SECRET_ACCESS_KEY);
    if (name === "GetBucketVersioningCommand")
      return { Status: mode === "unversioned" ? "Suspended" : "Enabled" };
    if (name === "GetObjectLockConfigurationCommand")
      return {
        ObjectLockConfiguration: {
          ObjectLockEnabled: "Enabled",
          ...(mode === "default-lock"
            ? { Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 90 } } }
            : {}),
        },
      };
    if (name === "GetBucketAclCommand")
      return {
        Owner: { ID: "owner" },
        Grants: [
          {
            Grantee:
              mode === "public"
                ? { Type: "Group", URI: "public" }
                : { Type: "CanonicalUser", ID: "owner" },
          },
        ],
      };
    const versions = objects.get(x.Key) || [];
    let object = x.VersionId
      ? versions.find((v) => v.VersionId === x.VersionId)
      : versions[0];
    if (name === "PutObjectCommand") {
      const chunks = [];
      if (Buffer.isBuffer(x.Body)) chunks.push(x.Body);
      else for await (const c of x.Body) chunks.push(c);
      const bytes = Buffer.concat(chunks);
      if (x.IfNoneMatch === "*" && versions.length && mode !== "conditional")
        reject(412, "PreconditionFailed");
      const checksum = crypto
        .createHash("sha256")
        .update(bytes)
        .digest("base64");
      if (x.ChecksumSHA256 !== checksum && mode !== "checksum")
        reject(400, mode === "wrong-error" ? "InvalidRequest" : "BadDigest");
      const v = {
        VersionId: "version-" + ++sequence,
        bytes,
        ContentLength: bytes.length,
        ServerSideEncryption: "AES256",
        ObjectLockMode: mode === "lock" ? null : x.ObjectLockMode,
        ObjectLockRetainUntilDate:
          mode === "lock" ? null : x.ObjectLockRetainUntilDate,
        hold: false,
      };
      objects.set(x.Key, [v, ...versions]);
      return { VersionId: v.VersionId };
    }
    if (name === "ListObjectVersionsCommand")
      return {
        IsTruncated: false,
        Versions: [...objects].flatMap(([Key, values]) =>
          Key === x.Prefix
            ? values.map((v) => ({
                Key,
                VersionId: v.VersionId,
                Size: v.bytes.length,
              }))
            : [],
        ),
      };
    if (!object) reject(404, "NoSuchKey");
    if (name === "HeadObjectCommand") return { ...object };
    if (name === "GetObjectCommand") {
      if (mode === "unpinned") object = versions[0];
      return {
        Body: Readable.from([object.bytes]),
        VersionId: object.VersionId,
      };
    }
    if (name === "PutObjectRetentionCommand") {
      if (
        object.ObjectLockMode === "COMPLIANCE" &&
        x.Retention.RetainUntilDate < object.ObjectLockRetainUntilDate
      )
        reject(403);
      if (!["extension", "lock"].includes(mode)) {
        object.ObjectLockMode = x.Retention.Mode;
        object.ObjectLockRetainUntilDate = x.Retention.RetainUntilDate;
      }
      return {};
    }
    if (name === "PutObjectLegalHoldCommand") {
      if (mode !== "hold") object.hold = x.LegalHold.Status === "ON";
      return {};
    }
    if (name === "GetObjectLegalHoldCommand")
      return { LegalHold: { Status: object.hold ? "ON" : "OFF" } };
    if (name === "DeleteObjectCommand") {
      if (object.hold || object.ObjectLockRetainUntilDate?.getTime() > now)
        reject(403);
      objects.set(
        x.Key,
        mode === "delete-all"
          ? []
          : versions.filter((v) => v.VersionId !== x.VersionId),
      );
      return {};
    }
    throw Error("Unexpected fixture operation");
  };
  return { archive: a, objects, calls };
}
test("storage qualification plans are local, tiny, private and contain no credentials", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "config.json");
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const c = readConfig(file),
    plan = prepare(c, f.directory, { now: f.now });
  assert.equal(plan.objects.length, 3);
  assert.ok(plan.objects.reduce((n, o) => n + o.bytes, 0) < 1024);
  assert.equal(plan.retainUntil - f.now, 25 * 3600000);
  assert.equal(plan.expiresAt - f.now, 1800000);
  assert.equal(plan.sourceFootageIncluded, false);
  assert.equal(plan.purchasesAuthorized, false);
  assert.equal(
    fs.statSync(path.join(f.directory, "plan.json")).mode & 0o077,
    0,
  );
  assert.equal(
    JSON.stringify(plan).includes(config.AWS_SECRET_ACCESS_KEY),
    false,
  );
  assert.throws(() => prepare(c, f.directory), /EEXIST/);
  const child = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../security/deploy/check-archive.cjs"),
      "plan",
      file,
      path.join(f.root, "cli-plan"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).networkRequests, 0);
  assert.equal(child.stdout.includes(config.AWS_ACCESS_KEY_ID), false);
});
test("private provider config rejects unsafe files, credential inheritance and unsupported settings", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "config.json"),
    link = path.join(f.root, "link.json");
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  fs.symlinkSync(file, link);
  assert.throws(() => readConfig(link), /PRIVATE_ARCHIVE_CHECK_CONFIG_INVALID/);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readConfig(file), /PRIVATE_ARCHIVE_CHECK_CONFIG_INVALID/);
  fs.chmodSync(file, 0o600);
  for (const patch of [
    { AWS_SECRET_ACCESS_KEY: "" },
    { SECURITY_S3_ENDPOINT: "http://fixture.invalid" },
    { SECURITY_S3_ENDPOINT: "https://user:secret@fixture.invalid" },
    { SECURITY_S3_ENDPOINT: "https://fixture.invalid/?secret=x" },
    { RING_CLIENT_SECRET: "forbidden" },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
    assert.throws(
      () => readConfig(file),
      /PRIVATE_ARCHIVE_CHECK_CONFIG_INVALID/,
    );
  }
});
test("the complete synthetic contract checks distinct versions, conditional writes, checksums and locks without declaring full qualification", async (t) => {
  const f = fixture(t),
    plan = prepare(config, f.directory, { now: f.now }),
    backend = fake("good", f.now);
  const report = await run(config, f.directory, "fixture approval", {
    now: () => f.now,
    createArchive: () => backend.archive,
  });
  assert.equal(report.contractChecksPassed, true, JSON.stringify(report.steps));
  assert.equal(report.qualificationPassed, false);
  assert.equal(report.steps.length, 9);
  assert.ok(report.steps.every((s) => s.state === "passed"));
  assert.equal(report.objects[0].versions.length, 0);
  assert.equal(report.objects[2].versions.length, 0);
  assert.equal(report.objects[1].versions.length, 1);
  const retained = backend.objects.get(plan.objects[1].objectKey)[0];
  assert.equal(retained.hold, false);
  assert.equal(retained.ObjectLockMode, "COMPLIANCE");
  assert.equal(
    retained.ObjectLockRetainUntilDate.getTime(),
    plan.retainUntil + 60000,
  );
  assert.equal(
    JSON.stringify(report).includes(config.AWS_SECRET_ACCESS_KEY),
    false,
  );
  assert.ok(
    backend.calls.every(
      (c) => !c.name.startsWith("Create") && !c.name.includes("Lifecycle"),
    ),
  );
  assert.ok(
    backend.calls
      .filter((c) => c.input.Key)
      .every((c) => plan.objects.some((o) => o.objectKey === c.input.Key)),
  );
  let invoked = false;
  await assert.rejects(
    run(config, f.directory, "fixture approval", {
      now: () => f.now,
      createArchive: () => {
        invoked = true;
      },
    }),
    /EEXIST/,
  );
  assert.equal(invoked, false);
});
test("weaker provider behavior never passes and unexpected versions remain inventoried for review", async (t) => {
  for (const mode of [
    "conditional",
    "checksum",
    "wrong-error",
    "unpinned",
    "delete-all",
    "lock",
    "hold",
    "extension",
    "unversioned",
    "default-lock",
    "public",
    "provider-secret",
  ]) {
    const f = fixture(t),
      plan = prepare(config, f.directory, { now: f.now }),
      backend = fake(mode, f.now);
    const report = await run(config, f.directory, "fixture approval", {
      now: () => f.now,
      createArchive: () => backend.archive,
    });
    assert.equal(report.contractChecksPassed, false, mode);
    assert.equal(report.qualificationPassed, false, mode);
    assert.ok(report.error, mode);
    assert.equal(
      JSON.stringify(report).includes(config.AWS_SECRET_ACCESS_KEY),
      false,
      mode,
    );
    assert.equal(
      JSON.stringify(report).includes("PRIVATE_PROVIDER_DETAIL"),
      false,
      mode,
    );
    if (
      ["unversioned", "default-lock", "public", "provider-secret"].includes(
        mode,
      )
    )
      assert.equal(
        backend.calls.some((c) => c.name === "PutObjectCommand"),
        false,
        mode,
      );
    if (mode === "conditional")
      assert.equal(report.objects[0].versions.length, 2);
    if (mode === "checksum") assert.equal(report.objects[2].versions.length, 1);
    if (mode === "hold")
      assert.ok(
        backend.objects
          .get(plan.objects[1].objectKey)[0]
          .ObjectLockRetainUntilDate.getTime() > f.now,
      );
  }
});
test("expired, retargeted, changed or symlinked test plans fail before any provider request", async (t) => {
  for (const mode of [
    "expired",
    "retargeted",
    "changed-description",
    "changed-target",
    "changed-body",
    "symlink",
    "no-approval",
  ]) {
    const f = fixture(t),
      plan = prepare(config, f.directory, { now: f.now });
    let invoked = false;
    const file = path.join(f.directory, plan.objects[0].file);
    if (mode === "changed-description" || mode === "changed-target") {
      const changed = JSON.parse(JSON.stringify(plan));
      if (mode === "changed-description") changed.effects = ["Read only"];
      else changed.target.bucket = "another-bucket";
      fs.writeFileSync(
        path.join(f.directory, "plan.json"),
        JSON.stringify(changed),
      );
    }
    if (mode === "changed-body")
      fs.writeFileSync(file, "real footage must not be accepted");
    if (mode === "symlink") {
      fs.renameSync(file, file + ".old");
      fs.symlinkSync(file + ".old", file);
    }
    await assert.rejects(
      run(
        mode === "retargeted"
          ? { ...config, SECURITY_S3_BUCKET: "another-bucket" }
          : config,
        f.directory,
        mode === "no-approval" ? "" : "fixture approval",
        {
          now: () => f.now + (mode === "expired" ? 1800001 : 0),
          createArchive: () => {
            invoked = true;
            throw Error();
          },
        },
      ),
    );
    assert.equal(invoked, false, mode);
    assert.equal(
      fs.existsSync(path.join(f.directory, "RUN_STARTED")),
      false,
      mode,
    );
  }
});
test(
  "a killed qualification run retains its uncertain outcome and cannot silently replay provider writes",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    prepare(config, f.directory, { now: f.now });
    const file = path.join(f.root, "killed-run.cjs"),
      reached = path.join(f.root, "reached");
    const modulePath = path.resolve(
        __dirname,
        "../../security/deploy/check-archive.cjs",
      ),
      archivePath = path.resolve(
        __dirname,
        "../../security/server/archive.cjs",
      );
    fs.writeFileSync(
      file,
      `const fs=require('node:fs');const {run}=require(${JSON.stringify(modulePath)});const {S3Archive}=require(${JSON.stringify(archivePath)});const config=${JSON.stringify(config)};setInterval(()=>{},1000);run(config,${JSON.stringify(f.directory)},'fixture crash approval',{createArchive(){const a=new S3Archive(config,{credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'}});a.client.send=async c=>{switch(c.constructor.name){case 'GetBucketVersioningCommand':return{Status:'Enabled'};case 'GetObjectLockConfigurationCommand':return{ObjectLockConfiguration:{ObjectLockEnabled:'Enabled'}};case 'GetBucketAclCommand':return{Owner:{ID:'owner'},Grants:[]};case 'HeadObjectCommand':throw{$metadata:{httpStatusCode:404}};case 'PutObjectCommand':fs.writeFileSync(${JSON.stringify(reached)},'entered');return new Promise(()=>{});default:throw Error();}};return a;}});`,
    );
    const child = spawn(process.execPath, [file], { stdio: "ignore" });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(reached)) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 20));
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    const report = JSON.parse(
      fs.readFileSync(path.join(f.directory, "result.json")),
    );
    assert.equal(report.contractChecksPassed, false);
    assert.equal(report.steps.at(-1).state, "running");
    let invoked = false;
    await assert.rejects(
      run(config, f.directory, "fixture retry", {
        createArchive: () => {
          invoked = true;
        },
      }),
      /EEXIST/,
    );
    assert.equal(invoked, false);
  },
);
