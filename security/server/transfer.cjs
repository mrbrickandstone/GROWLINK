"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DiskGuard, JOB_HEADROOM } = require("./capacity.cjs");
function command(bin, args, timeout, disk) {
  disk.assertSpace(JOB_HEADROOM);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "ignore", timeout });
    let fault, killTimer;
    const monitor = setInterval(() => {
      try {
        disk.assertSpace();
      } catch (e) {
        fault = e;
        clearInterval(monitor);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }
    }, 2000);
    const done = (code) => {
      clearInterval(monitor);
      clearTimeout(killTimer);
      if (!fault) {
        try {
          disk.assertSpace();
        } catch (e) {
          fault = e;
        }
      }
      fault ? reject(fault) : resolve({ status: code });
    };
    child.once("error", () => done(1));
    child.once("exit", done);
  });
}
const {
  followMedia,
  preserveMedia,
  hashFile,
  retryPolicy,
} = require("../../lib/security/ring-pilot.cjs");
const { assessMedia } = require("../../lib/security/coverage.cjs");
const { DAY, error } = require("./store.cjs");
const { probe: probeAsync } = require("./probe.cjs");
const { pipeline } = require("node:stream/promises");
function prepareDirectories(store) {
  for (const dir of ["staging/originals", "derivatives", "exports"])
    fs.mkdirSync(path.join(store.root, dir), { recursive: true, mode: 0o700 });
}
async function derive(store, file, id, disk = new DiskGuard(store.root)) {
  const dir = path.join(store.root, "derivatives"),
    video = path.join(dir, id + ".mp4"),
    image = path.join(dir, id + ".jpg");
  if (!fs.existsSync(video)) {
    const temp = path.join(dir, id + "." + crypto.randomUUID() + ".mp4");
    let r;
    try {
      r = await command(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          file,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          "scale=-2:720",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "24",
          "-movflags",
          "+faststart",
          "-y",
          temp,
        ],
        300000,
        disk,
      );
    } catch (e) {
      try {
        fs.unlinkSync(temp);
      } catch {}
      throw e;
    }
    if (r.status !== 0) {
      try {
        fs.unlinkSync(temp);
      } catch {}
      throw error("DERIVATIVE_FAILED", 502);
    }
    fs.renameSync(temp, video);
    fs.chmodSync(video, 0o600);
  }
  if (!fs.existsSync(image)) {
    const tempImage = path.join(dir, id + "." + crypto.randomUUID() + ".jpg");
    let r;
    try {
      r = await command(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          video,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          "-y",
          tempImage,
        ],
        30000,
        disk,
      );
      if (r.status !== 0) throw error("THUMBNAIL_FAILED", 502);
      fs.renameSync(tempImage, image);
    } finally {
      try {
        fs.unlinkSync(tempImage);
      } catch {}
    }
    fs.chmodSync(image, 0o600);
  }
  return { video: path.basename(video), image: path.basename(image) };
}
async function transfer(
  store,
  archive,
  job,
  { ring, disk = new DiskGuard(store.root) } = {},
) {
  disk.assertSpace(JOB_HEADROOM);
  prepareDirectories(store);
  const p = job.payload,
    camera = store.get("cameras", p.cameraId);
  if (!camera) throw error("CAMERA_NOT_FOUND");
  let file, sha, size, assessment, probe;
  const prior = store.get("segments", job.id);
  if (
    prior?.deletedAt ||
    store
      .all("deletions")
      .some(
        (d) =>
          d.segmentId === job.id && ["approved", "deleted"].includes(d.state),
      )
  )
    throw error("DELETION_INTENT_BLOCKS_REIMPORT", 409);
  if (prior?.verified && (await archive.verify(prior.receipt))) {
    file = path.join(store.root, "staging", job.id + ".resume.mp4");
    await pipeline(
      await archive.read(prior.receipt),
      disk.writer(),
      fs.createWriteStream(file, { mode: 0o600 }),
    );
    if ((await hashFile(file)) !== prior.sha256)
      throw error("ARCHIVE_READBACK_MISMATCH", 409);
    const derivative = await derive(store, file, job.id, disk);
    derivative.sha256 = await hashFile(
      path.join(store.root, "derivatives", derivative.video),
    );
    store.tx(() => {
      store.renew(job);
      store.put("segments", prior.id, { ...prior, derivative });
      store.finish(job, "complete");
      store.audit({ id: "transfer-worker" }, "playback.derivative.recovered", {
        segmentId: prior.id,
      });
    });
    return { ...prior, derivative };
  }
  if (
    camera.source === "ring" &&
    archive.lockApproved &&
    !store.get("policy", "ring")?.retentionApproved
  )
    throw error("RING_IRREVERSIBLE_RETENTION_NOT_APPROVED", 409);
  if (p.kind === "pilot-import") {
    file = p.file;
    sha = p.sha256;
    size = fs.statSync(file).size;
    if ((await hashFile(file)) !== sha || size !== p.size)
      throw error("SOURCE_HASH_MISMATCH");
    probe = await probeAsync(file);
    assessment = assessMedia(
      { start: p.requestStart, end: p.requestEnd },
      { status: 200, timestamp: p.actualStart, length: null },
      probe,
    );
  } else if (p.kind === "ring-export") {
    const policy = store.get("policy", "ring");
    if (
      !ring ||
      !policy?.automatedExportsApproved ||
      !policy?.decisionReference
    )
      throw error("RING_UNATTENDED_EXPORT_NOT_APPROVED", 409);
    const raw = await ring.pilotRequest("download", {
      device: camera.providerId,
      body: {
        timestamp: p.requestStart,
        duration: p.requestEnd - p.requestStart,
      },
    });
    const { response, timestamp, length } = await followMedia(raw);
    if (![200, 206].includes(response.status)) {
      const retryAt = retryPolicy(
        response.status,
        job.attempts,
        store.now(),
        p.requestEnd,
        response.headers.get("retry-after"),
      );
      await response.body?.cancel();
      throw Object.assign(
        error(`RING_HTTP_${response.status}`, retryAt ? 502 : 409),
        { retryAt },
      );
    }
    const media = await preserveMedia(
      response,
      path.join(store.root, "staging"),
      job.id,
      512 * 1024 * 1024,
      (bytes) => disk.assertSpace(bytes),
    );
    file = path.join(store.root, "staging", media.file);
    sha = media.sha256;
    size = media.size;
    probe = await probeAsync(file);
    assessment = assessMedia(
      { start: p.requestStart, end: p.requestEnd },
      { status: response.status, timestamp, length },
      probe,
    );
  } else throw error("RECORDER_ADAPTER_ACCESS_REQUIRED", 409);
  if (!assessment.verified) throw error("MEDIA_VERIFICATION_FAILED", 409);
  if (prior && prior.sha256 !== sha)
    throw error("SOURCE_BYTES_CHANGED_FOR_JOB", 409);
  const ingestedAt =
    prior?.ingestedAt || store.get("ingestions", job.id)?.at || store.now();
  store.put("ingestions", job.id, { at: ingestedAt });
  const retainUntil = Math.max(
    ingestedAt + 90 * DAY,
    assessment.actualEnd + 60 * DAY,
  );
  disk.assertSpace(JOB_HEADROOM);
  const receipt = await archive.put(file, sha, size, retainUntil, {
    beforeWrite: (bytes) => disk.assertSpace(bytes),
  });
  if (archive.lockApproved && !receipt.immutableStorageVerified)
    throw error("RETENTION_PROTECTION_UNVERIFIED", 409);
  const s = {
    id: job.id,
    cameraId: camera.id,
    source: camera.source,
    start: assessment.actualStart,
    end: assessment.actualEnd,
    requested: { start: p.requestStart, end: p.requestEnd },
    sha256: sha,
    bytes: size,
    verified: true,
    probe,
    provenance:
      camera.source === "ring" ? "vendor-delivered" : "unverified-native",
    vendorTransformations:
      camera.source === "ring"
        ? [
            "Ring server watermark",
            "Vendor encoding/transformation not independently authenticated",
          ]
        : [],
    nativeAuthentication: "unverified",
    ingestedAt,
    receipt,
    derivative: null,
  };
  for (const h of store.held(s)) {
    if (
      archive.independent &&
      (s.source !== "ring" || store.get("policy", "ring")?.retentionApproved)
    ) {
      await archive.setHold(receipt);
      store.put("holds", h.id, {
        ...h,
        archiveProtection: "confirmed",
        archiveCheckedAt: store.now(),
      });
    }
  }
  store.tx(() => {
    store.renew(job);
    store.put("segments", s.id, {
      ...s,
      derivative: prior?.derivative || null,
    });
    store.audit({ id: "transfer-worker" }, "archive.original.verified", {
      segmentId: s.id,
      cameraId: s.cameraId,
      sha256: sha,
      bytes: size,
      independent: receipt.independent,
    });
  });
  s.derivative = await derive(store, file, job.id, disk);
  s.derivative.sha256 = await hashFile(
    path.join(store.root, "derivatives", s.derivative.video),
  );
  store.tx(() => {
    store.renew(job);
    store.put("segments", s.id, s);
    store.finish(job, "complete");
    store.audit({ id: "transfer-worker" }, "playback.derivative.created", {
      segmentId: s.id,
      sha256: s.derivative.sha256,
    });
  });
  return s;
}
async function reconcile(store, archive) {
  let invalid = 0;
  for (const s of store
    .all("segments")
    .filter((s) => s.verified && !s.deletedAt)) {
    if (!(await archive.verify(s.receipt))) {
      store.tx(() => {
        store.put("segments", s.id, {
          ...s,
          verified: false,
          verificationError: "ARCHIVE_RECONCILIATION_FAILED",
        });
        if (
          !store
            .all("deletions")
            .some(
              (d) =>
                d.segmentId === s.id &&
                ["approved", "deleted"].includes(d.state),
            )
        )
          store.db
            .prepare(
              "UPDATE jobs SET state='queued',next=0 WHERE id=? AND state='complete'",
            )
            .run(s.id);
        store.audit(
          { id: "transfer-worker" },
          "archive.reconciliation.failed",
          { segmentId: s.id },
        );
      });
      invalid++;
    }
  }
  return { checked: store.all("segments").length, invalid };
}
function scheduleRing(store) {
  const policy = store.get("policy", "ring");
  if (!policy?.automatedExportsApproved || !policy.decisionReference) return 0;
  let count = 0;
  const ready = Math.floor((store.now() - 300000) / 299000) * 299000;
  for (const c of store
    .all("cameras")
    .filter((c) => c.source === "ring" && c.exportEnabled && c.enabledAt)) {
    const start = Math.max(c.enabledAt, ready - 13 * DAY);
    for (let t = start; t + 299000 <= ready; t += 299000) {
      store.enqueue({
        kind: "ring-export",
        cameraId: c.id,
        requestStart: Math.max(c.enabledAt, t - 1000),
        requestEnd: t + 299000,
      });
      count++;
    }
  }
  return count;
}
async function reconcileHolds(store, archive) {
  if (!archive.independent) return;
  for (const h of store.all("holds").filter((h) => h.state !== "released")) {
    const segments = store
      .all("segments")
      .filter(
        (s) =>
          !s.deletedAt &&
          s.cameraId === h.cameraId &&
          s.start < h.end &&
          s.end > h.start,
      );
    if (!segments.length) continue;
    if (
      segments.some(
        (s) =>
          s.source === "ring" &&
          !store.get("policy", "ring")?.retentionApproved,
      )
    )
      continue;
    for (const s of segments) await archive.setHold(s.receipt);
    const current = store.get("holds", h.id);
    if (current.state !== "released")
      store.put("holds", h.id, {
        ...current,
        archiveProtection: "confirmed",
        archiveCheckedAt: store.now(),
      });
  }
}
module.exports = {
  prepareDirectories,
  derive,
  transfer,
  reconcile,
  reconcileHolds,
  scheduleRing,
};
