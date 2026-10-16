"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { coverage } = require("../../lib/security/coverage.cjs");
const { error, text } = require("./store.cjs");
function signingKey(root) {
  const file = path.join(root, "evidence-signing.pem");
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    try {
      fs.writeFileSync(
        file,
        privateKey.export({ type: "pkcs8", format: "pem" }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return crypto.createPrivateKey(fs.readFileSync(file));
}
async function evidence(store, archive, actor, input) {
  const { cameraId, start, end } = input;
  require("../../lib/security/coverage.cjs").windowRange(start, end);
  store.authorize(actor, "export", cameraId, { start, end });
  const segments = store
    .all("segments")
    .filter(
      (s) =>
        s.cameraId === cameraId &&
        s.end > start &&
        s.start < end &&
        !s.deletedAt,
    );
  if (!segments.length) throw error("NO_FOOTAGE_FOR_EXPORT", 404);
  for (const s of segments) {
    store.authorize(actor, "export", cameraId, { start: s.start, end: s.end });
    if (!s.verified || !(await archive.verify(s.receipt)))
      throw error("EVIDENCE_READBACK_FAILED", 409);
  }
  // Permission and revocation may change during readback. Recheck before release.
  for (const s of segments)
    store.authorize(actor, "export", cameraId, { start: s.start, end: s.end });
  const key = signingKey(store.root),
    id = input.exportId || crypto.randomUUID();
  const manifest = {
    schema: "farber-evidence-v1",
    id,
    requestId: text(input.requestId),
    purpose: text(input.purpose, 2000),
    exportedAt: store.now(),
    exportedBy: actor.id,
    cameraId,
    requested: { start, end },
    timezone: "America/New_York",
    coverage: coverage(start, end, segments),
    cameraNativeAuthentication: "unverified",
    handlingSignature:
      "Ed25519 signature over exact manifest bytes; attests only to handling since receipt",
    auditCheckpoint: store.auditIntegrity(),
    files: segments.map((s) => ({
      segmentId: s.id,
      name: s.sha256 + ".mp4",
      sha256: s.sha256,
      bytes: s.bytes,
      start: s.start,
      end: s.end,
      provenance: s.provenance,
      source: s.source,
      vendorTransformations: s.vendorTransformations || [],
      archiveVersion: s.receipt.versionId,
      holds: store.held(s).map((h) => h.id),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    signature = crypto.sign(null, bytes, key).toString("base64"),
    publicKey = crypto
      .createPublicKey(key)
      .export({ type: "spki", format: "pem" });
  const record = {
    id,
    state: "complete",
    manifestText: bytes.toString(),
    signature,
    publicKey,
    createdBy: actor.id,
    cameraId,
    start,
    end,
    segmentIds: segments.map((s) => s.id),
    createdAt: store.now(),
  };
  store.tx(() => {
    store.put("exports", id, record);
    store.audit(actor, "evidence.export.created", {
      exportId: id,
      requestId: manifest.requestId,
      cameraId,
      start,
      end,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });
  return record;
}
function queueEvidence(store, actor, input) {
  const { cameraId, start, end } = input;
  require("../../lib/security/coverage.cjs").windowRange(start, end);
  store.authorize(actor, "export", cameraId, { start, end });
  const request = {
    cameraId,
    start,
    end,
    requestId: text(input.requestId),
    purpose: text(input.purpose, 2000),
  };
  const candidates = store
    .all("segments")
    .filter(
      (s) =>
        s.cameraId === cameraId &&
        s.end > start &&
        s.start < end &&
        !s.deletedAt,
    );
  if (!candidates.length) throw error("NO_FOOTAGE_FOR_EXPORT", 404);
  for (const s of candidates)
    store.authorize(actor, "export", cameraId, { start: s.start, end: s.end });
  return store.tx(() => {
    const id = crypto.randomUUID(),
      jobId = store.enqueue({
        kind: "evidence-export",
        exportId: id,
        userId: actor.id,
        mfa: actor.mfa === true,
        request,
      });
    const record = {
      id,
      state: "queued",
      jobId,
      createdBy: actor.id,
      cameraId,
      start,
      end,
      requestId: request.requestId,
      createdAt: store.now(),
    };
    store.put("exports", id, record);
    store.audit(actor, "evidence.export.requested", {
      id,
      jobId,
      cameraId,
      start,
      end,
      requestId: request.requestId,
    });
    return record;
  });
}
async function processEvidence(store, archive, job) {
  const p = job.payload,
    u = store.user(p.userId);
  if (!u) throw error("USER_DISABLED", 409);
  const actor = { ...u, mfa: p.mfa, externalAuthenticated: true },
    prior = store.get("exports", p.exportId);
  store.authorize(actor, "export", p.request.cameraId, p.request);
  if (prior?.state === "complete") {
    for (const id of prior.segmentIds) {
      const s = store.get("segments", id);
      store.authorize(actor, "export", s.cameraId, s);
    }
    store.finish(job, "complete");
    return prior;
  }
  const record = await evidence(store, archive, actor, {
    ...p.request,
    exportId: p.exportId,
  });
  store.finish(job, "complete");
  return record;
}
module.exports = { evidence, signingKey, queueEvidence, processEvidence };
