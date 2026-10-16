"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { DatabaseSync } = require("node:sqlite");
const { verifySnapshot, inspectDatabase } = require("./backup.cjs");
const { digest } = require("./audit.cjs");
const HEX = /^[a-f0-9]{64}$/;
const STALE = new Set([
  "heartbeats",
  "pipeline-health",
  "verification-health",
  "archive-checks",
  "access",
  "cache-access",
  "cache-evictions",
  "cache-assessments",
  "playback-requests",
  "login-rate",
]);
function fail(code) {
  throw Error(code);
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
function syncDirectory(root) {
  const fd = fs.openSync(root, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
async function prepareRecovery(
  source,
  checkpoint,
  destination,
  reference,
  options = {},
) {
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.length > 200
  )
    fail("RECOVERY_REVIEW_REFERENCE_REQUIRED");
  if (
    checkpoint?.schema !== "farber-backup-checkpoint-v1" ||
    !HEX.test(checkpoint.snapshotId || "") ||
    !HEX.test(checkpoint.manifestSha256 || "") ||
    checkpoint.restoreVerified !== true
  )
    fail("TRUSTED_BACKUP_CHECKPOINT_REQUIRED");
  const manifest = await verifySnapshot(source, checkpoint.manifestSha256);
  if (
    checkpoint.createdAt !== manifest.createdAt ||
    checkpoint.audit?.head !== manifest.database.audit.head ||
    checkpoint.audit?.count !== manifest.database.audit.count
  )
    fail("RECOVERY_CHECKPOINT_METADATA_MISMATCH");
  if (!path.isAbsolute(destination))
    fail("NEW_ABSOLUTE_RECOVERY_PATH_REQUIRED");
  const root = path.join(
    fs.realpathSync(path.dirname(destination)),
    path.basename(destination),
  );
  // Never mutate the restored snapshot or reuse an incomplete candidate.
  if (
    root === fs.realpathSync(source) ||
    root.startsWith(fs.realpathSync(source) + path.sep)
  )
    fail("SEPARATE_RECOVERY_TARGET_REQUIRED");
  fs.mkdirSync(root, { mode: 0o700 });
  write(
    path.join(root, "RECOVERY_REQUIRED"),
    fs.readFileSync(path.join(source, "RECOVERY_REQUIRED")),
  );
  syncDirectory(root);
  let db;
  try {
    for (const name of [
      ...manifest.files.map((f) => f.name),
      "backup-manifest.json",
    ])
      if (name !== "RECOVERY_REQUIRED") {
        fs.copyFileSync(
          path.join(source, name),
          path.join(root, name),
          fs.constants.COPYFILE_EXCL,
        );
        fs.chmodSync(path.join(root, name), 0o600);
      }
    // Verify the actual copied bytes before opening a writable connection.
    await verifySnapshot(root, checkpoint.manifestSha256);
    await options.onStage?.("copied", root);
    db = new DatabaseSync(path.join(root, "command.sqlite"));
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    const put = db.prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      ),
      remove = db.prepare("DELETE FROM records WHERE kind=? AND id=?"),
      at = Date.now(),
      id = crypto.randomUUID(),
      counts = {
        sessionsRevoked: 0,
        usersDisabled: 0,
        grantsRevoked: 0,
        exportsSuspended: 0,
        deletionApprovalsInvalidated: 0,
        jobsPaused: 0,
        segmentsRequireReadback: 0,
        staleObservationsRemoved: 0,
      };
    const save = (kind, key, value) =>
      put.run(kind, key, JSON.stringify(value));
    const history = (kind, key, value) =>
      save("recovery-history", digest(id + "|" + kind + "|" + key), {
        recoveryId: id,
        kind,
        id: key,
        value,
      });
    const previousRecoveryRow = db
      .prepare(
        "SELECT data FROM records WHERE kind='recovery' AND id='control'",
      )
      .get();
    const previousRecovery =
      previousRecoveryRow && JSON.parse(previousRecoveryRow.data);
    if (previousRecovery) {
      if (
        previousRecovery.state !== "released" ||
        !previousRecovery.activation?.planId
      )
        fail("NESTED_RECOVERY_REQUIRES_REVIEW");
      history("recovery", "control", previousRecovery);
    }
    for (const row of db.prepare("SELECT * FROM records").all()) {
      const value = JSON.parse(row.data),
        next = { ...value };
      let changed = true;
      if (STALE.has(row.kind)) {
        history(row.kind, row.id, value);
        remove.run(row.kind, row.id);
        counts.staleObservationsRemoved++;
        continue;
      }
      switch (row.kind) {
        case "users":
          next.enabled = false;
          counts.usersDisabled++;
          break;
        case "grants":
          next.revokedAt = value.revokedAt || at;
          counts.grantsRevoked++;
          break;
        case "exports":
          next.recoveryPreviousState =
            value.recoveryPreviousState || value.state;
          next.state = "recovery-suspended";
          next.recoverySuspendedAt = at;
          counts.exportsSuspended++;
          break;
        case "deletions":
          if (["requested", "approved"].includes(value.state)) {
            next.state = "recovery-invalidated";
            next.recoveryInvalidatedAt = at;
            delete next.approvedBy;
            delete next.approvedAt;
            counts.deletionApprovalsInvalidated++;
          } else changed = false;
          break;
        case "cameras":
          next.exportEnabled = false;
          break;
        case "policy":
          if (row.id === "ring") {
            next.automatedExportsApproved = false;
            next.retentionApproved = false;
            next.inspectorApproved = false;
            next.decisionReference = null;
          } else changed = false;
          break;
        case "segments":
          next.verified = false;
          next.derivative = null;
          next.cache = null;
          if (!value.deletedAt) {
            next.verificationError = "ARCHIVE_RECOVERY_REQUIRED";
            counts.segmentsRequireReadback++;
          }
          if (value.receipt)
            next.receipt = {
              ...value.receipt,
              readbackVerifiedAt: null,
              immutableStorageVerified: false,
            };
          break;
        case "holds":
          if (value.state !== "released") {
            next.archiveProtection = "unconfirmed";
            next.archiveCheckedAt = null;
          } else changed = false;
          break;
        default:
          changed = false;
      }
      if (changed) {
        history(row.kind, row.id, value);
        save(row.kind, row.id, next);
      }
    }
    counts.sessionsRevoked = db.prepare("DELETE FROM sessions").run().changes;
    for (const job of db
      .prepare(
        "SELECT * FROM jobs WHERE state NOT IN ('complete','recovery-retired')",
      )
      .all()) {
      history("jobs", job.id, { ...job, payload: JSON.parse(job.payload) });
      db.prepare(
        "UPDATE jobs SET state='blocked',owner=NULL,lease=NULL,next=0,error='RECOVERY_REVIEW_REQUIRED' WHERE id=?",
      ).run(job.id);
      counts.jobsPaused++;
    }
    const recovery = {
      schema: "farber-recovery-v1",
      id,
      state: "review-required",
      preparedAt: at,
      reference: reference.trim(),
      snapshotId: checkpoint.snapshotId,
      manifestSha256: checkpoint.manifestSha256,
      sourceCreatedAt: manifest.createdAt,
      sourceAudit: manifest.database.audit,
      counts,
      newestSnapshotVerified: false,
      postSnapshotChangesReconciled: false,
      productionReady: false,
      previousRecoveryId: previousRecovery?.id || null,
    };
    save("recovery", "control", recovery);
    const previous =
        db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get()
          ?.hash || "0".repeat(64),
      event = JSON.stringify({
        at,
        actor: "local-recovery-administrator",
        action: "recovery.prepared",
        detail: recovery,
      });
    db.prepare("INSERT INTO audit(event,previous,hash) VALUES(?,?,?)").run(
      event,
      previous,
      digest(previous + "\n" + event),
    );
    db.exec("COMMIT");
    db.close();
    db = null;
    const inspected = inspectDatabase(root);
    if (
      !inspected.audit.valid ||
      inspected.sessions !== 0 ||
      inspected.signingKeyFingerprint !==
        manifest.database.signingKeyFingerprint ||
      inspected.signedExports !== manifest.database.signedExports
    )
      fail("RECOVERY_POSTCHECK_FAILED");
    await options.onStage?.("migrated", root);
    await verifySnapshot(source, checkpoint.manifestSha256);
    fs.renameSync(
      path.join(root, "backup-manifest.json"),
      path.join(root, "recovery-origin-manifest.json"),
    );
    const report = {
      ...recovery,
      audit: inspected.audit,
      sourceUnchanged: true,
      originalsIncluded: false,
      mode: "archive-readback-and-review-only",
    };
    write(
      path.join(root, "recovery-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    for (const file of [
      "command.sqlite",
      "recovery-origin-manifest.json",
      ...(manifest.database.signingKeyFingerprint
        ? ["evidence-signing.pem"]
        : []),
    ]) {
      const fd = fs.openSync(path.join(root, file), "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    // Publication is last. A crash before here keeps all normal services locked out.
    syncDirectory(root);
    fs.unlinkSync(path.join(root, "RECOVERY_REQUIRED"));
    syncDirectory(root);
    return report;
  } catch (e) {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    db?.close();
    // Preserve the incomplete candidate and marker for review; never overwrite or auto-retry it.
    throw e;
  }
}
module.exports = { prepareRecovery };
