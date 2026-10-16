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
const { scheduleRing } = require("./pipeline.cjs");
function prepareDirectories(store) {
  for (const dir of ["staging/originals", "derivatives", "exports"])
    fs.mkdirSync(path.join(store.root, dir), { recursive: true, mode: 0o700 });
}
async function derive(
  store,
  file,
  id,
  disk = new DiskGuard(store.root),
  force = false,
) {
  const dir = path.join(store.root, "derivatives"),
    video = path.join(dir, id + ".mp4"),
    image = path.join(dir, id + ".jpg");
  if (force || !fs.existsSync(video)) {
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
async function restoreDerivative(
  store,
  archive,
  s,
  disk = new DiskGuard(store.root),
) {
  disk.assertSpace(JOB_HEADROOM);
  prepareDirectories(store);
  if (
    !/^[a-f0-9]{64}$/.test(s.id) ||
    s.receipt?.sha256 !== s.sha256 ||
    s.receipt?.size !== s.bytes ||
    !Number.isSafeInteger(s.bytes) ||
    s.bytes < 1
  )
    throw error("INVALID_ARCHIVE_RECEIPT", 409);
  const file = path.join(
    store.root,
    "staging",
    s.id + "." + crypto.randomUUID() + ".restore.part",
  );
  let count = 0;
  const hash = crypto.createHash("sha256");
  const { Transform } = require("node:stream");
  try {
    await pipeline(
      await archive.read(s.receipt),
      new Transform({
        transform(chunk, enc, done) {
          count += chunk.length;
          if (count > s.bytes)
            return done(error("ARCHIVE_READBACK_MISMATCH", 409));
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      disk.writer(),
      fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    if (count !== s.bytes || hash.digest("hex") !== s.sha256)
      throw error("ARCHIVE_READBACK_MISMATCH", 409);
    const derivative = await derive(store, file, s.id, disk, true);
    derivative.sha256 = await hashFile(
      path.join(store.root, "derivatives", derivative.video),
    );
    return derivative;
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
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
  if (prior?.verified) {
    if (!(await archive.verify(prior.receipt)))
      throw error("ARCHIVE_READBACK_MISMATCH", 409);
    store.tx(() => {
      store.renew(job);
      queueBuild(store, prior);
      store.finish(job, "complete");
      store.audit({ id: "transfer-worker" }, "archive.transfer.recovered", {
        segmentId: prior.id,
      });
    });
    return prior;
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
    if (camera.exportEnabled !== true)
      throw error("CAMERA_EXPORTS_DISABLED", 409);
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
    derivative: prior?.derivative || null,
    cache: prior?.cache || null,
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
    store.put("segments", s.id, s);
    queueBuild(store, s);
    store.finish(job, "complete");
    store.audit({ id: "transfer-worker" }, "archive.original.verified", {
      segmentId: s.id,
      cameraId: s.cameraId,
      sha256: sha,
      bytes: size,
      independent: receipt.independent,
    });
  });
  return s;
}
function queueBuild(store, s) {
  if (store.playbackReady(s)) return;
  const id = store.enqueue({ kind: "playback-build", segmentId: s.id });
  store.db
    .prepare(
      "UPDATE jobs SET state='queued',next=0,error=NULL WHERE id=? AND state='complete'",
    )
    .run(id);
}
function buildable(store, id) {
  const s = store.get("segments", id);
  if (
    !s?.verified ||
    s.deletedAt ||
    store
      .all("deletions")
      .some(
        (d) => d.segmentId === id && ["approved", "deleted"].includes(d.state),
      )
  )
    throw error("PLAYBACK_ORIGINAL_UNAVAILABLE", 409);
  if (
    !Number.isSafeInteger(s.bytes) ||
    s.bytes < 1 ||
    s.receipt?.sha256 !== s.sha256 ||
    s.receipt?.size !== s.bytes
  )
    throw error("INVALID_ARCHIVE_RECEIPT", 409);
  return s;
}
async function buildPlayback(
  store,
  archive,
  job,
  { disk = new DiskGuard(store.root) } = {},
) {
  const s = buildable(store, job.payload.segmentId);
  if (store.playbackReady(s)) {
    store.finish(job, "complete");
    return s;
  }
  disk.assertSpace(JOB_HEADROOM);
  prepareDirectories(store);
  let derivative;
  if (/^[a-f0-9]{64}$/.test(s.id) && /^[a-f0-9]{64}$/.test(s.sha256)) {
    const file = path.join(
      store.root,
      "staging",
      "originals",
      `${s.id}.${s.sha256}.mp4`,
    );
    try {
      const stat = fs.lstatSync(file);
      if (
        stat.isFile() &&
        stat.nlink === 1 &&
        !(stat.mode & 0o077) &&
        fs.realpathSync(file) ===
          path.join(
            fs.realpathSync(store.root),
            "staging",
            "originals",
            `${s.id}.${s.sha256}.mp4`,
          ) &&
        stat.size === s.bytes &&
        (await hashFile(file)) === s.sha256
      ) {
        derivative = await derive(store, file, s.id, disk, true);
        derivative.sha256 = await hashFile(
          path.join(store.root, "derivatives", derivative.video),
        );
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!derivative)
    derivative = await restoreDerivative(store, archive, s, disk);
  return store.tx(() => {
    store.renew(job);
    const current = buildable(store, s.id);
    if (
      current.sha256 !== s.sha256 ||
      JSON.stringify(current.receipt) !== JSON.stringify(s.receipt)
    )
      throw error("ARCHIVE_RECEIPT_CHANGED", 409);
    const result = {
      ...current,
      derivative,
      cache: { ...current.cache, materializedAt: store.now() },
    };
    store.put("segments", s.id, result);
    store.finish(job, "complete");
    store.audit({ id: "transfer-worker" }, "playback.derivative.created", {
      segmentId: s.id,
      sha256: derivative.sha256,
    });
    return result;
  });
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
  restoreDerivative,
  transfer,
  buildPlayback,
  reconcile,
  reconcileHolds,
  scheduleRing,
};
