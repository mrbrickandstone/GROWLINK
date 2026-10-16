"use strict";
const crypto = require("node:crypto");
const { error, digest } = require("./store.cjs");
const TTL = 10 * 60000,
  READBACK_AGE = 24 * 3600000;
const REFERENCES = [
  "checkpoint",
  "changesAndHolds",
  "identities",
  "sourcePolicy",
  "hostAndStorage",
  "notificationReceipt",
];
function owner(store, actor) {
  const current = actor && store.user(actor.id);
  if (
    !current ||
    current.role !== "owner" ||
    actor.mfa !== true ||
    actor.readOnly
  )
    throw error("RECOVERY_NAMED_OWNER_MFA_REQUIRED", 403);
  for (const c of store.all("cameras"))
    if (!current.cameraIds.some((id) => id === "*" || id === c.id))
      throw error("RECOVERY_ALL_CAMERAS_REQUIRED", 403);
  if (!store.auditIntegrity().valid) throw error("AUDIT_INTEGRITY_FAILED", 409);
}
function reference(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw error("RECOVERY_EVIDENCE_REFERENCE_REQUIRED");
  return value.trim();
}
function fingerprint(store) {
  // Ignore ephemeral heartbeat, session and access observations. Bind the actual
  // control decisions and queue, including changed receipts and user permissions.
  const ephemeral = [
    "heartbeats",
    "pipeline-health",
    "verification-health",
    "archive-checks",
    "access",
    "cache-access",
    "login-rate",
    "recovery-reviews",
  ];
  const rows = store.db
    .prepare("SELECT kind,id,data FROM records ORDER BY kind,id")
    .all()
    .filter((r) => !ephemeral.includes(r.kind));
  const jobs = store.db.prepare("SELECT * FROM jobs ORDER BY id").all();
  return digest(JSON.stringify({ rows, jobs }));
}
function assessment(store) {
  const control = store.get("recovery", "control"),
    now = store.now();
  if (!control || control.schema !== "farber-recovery-v1")
    throw error("RECOVERY_NOT_PREPARED", 409);
  const segments = store
    .all("segments")
    .filter((s) => !s.deletedAt)
    .map((s) => {
      const at = s.receipt?.readbackVerifiedAt;
      const fresh =
        s.verified === true &&
        Number.isSafeInteger(at) &&
        at >= control.preparedAt &&
        at <= now &&
        now - at <= READBACK_AGE;
      return {
        id: s.id,
        cameraId: s.cameraId,
        start: s.start,
        end: s.end,
        readback: fresh ? "verified" : "unverified",
        independent: s.receipt?.independent === true,
        exceptionRequired: !fresh || s.receipt?.independent !== true,
      };
    });
  const jobs = store.db
    .prepare(
      "SELECT * FROM jobs WHERE state='blocked' AND error='RECOVERY_REVIEW_REQUIRED' ORDER BY id",
    )
    .all()
    .map((j) => {
      const p = JSON.parse(j.payload),
        camera = p.cameraId ? store.get("cameras", p.cameraId) : null,
        s = p.segmentId ? store.get("segments", p.segmentId) : null;
      const resume =
        (p.kind === "ring-export" &&
          camera?.source === "ring" &&
          camera?.exportEnabled === true &&
          store.get("policy", "ring")?.automatedExportsApproved === true &&
          typeof store.get("policy", "ring")?.decisionReference === "string" &&
          store.get("policy", "ring").decisionReference.trim().length > 0) ||
        (p.kind === "playback-build" && s?.verified === true && !s.deletedAt);
      return {
        id: j.id,
        kind: p.kind,
        cameraId: p.cameraId || s?.cameraId || null,
        requestStart: p.requestStart || null,
        requestEnd: p.requestEnd || null,
        action: ["evidence-export", "playback-restore"].includes(p.kind)
          ? "retire-request"
          : resume
            ? "resume"
            : "keep-paused",
      };
    });
  return {
    recoveryId: control.id,
    pending: store.recoveryPending(),
    preparedAt: control.preparedAt,
    sourceCreatedAt: control.sourceCreatedAt,
    segments,
    jobs,
    activeHolds: store.all("holds").filter((h) => h.state !== "released")
      .length,
    referenceFields: REFERENCES,
    limitations:
      "References are owner attestations. Activation does not verify vendor permission, unknown post-backup changes, retention, alert receipt or OCM compliance.",
    activation: control.activation || null,
  };
}
function status(store, actor) {
  owner(store, actor);
  return assessment(store);
}
function review(store, actor, input) {
  return store.tx(() => {
    owner(store, actor);
    const current = assessment(store);
    if (!current.pending) throw error("RECOVERY_ALREADY_RELEASED", 409);
    if (input?.reconciled !== true)
      throw error("RECOVERY_RECONCILIATION_ATTESTATION_REQUIRED");
    const references = Object.fromEntries(
      REFERENCES.map((k) => [k, reference(input.references?.[k])]),
    );
    const exceptions = current.segments.filter((s) => s.exceptionRequired);
    const exceptionReference = exceptions.length
      ? reference(input.exceptionReference)
      : null;
    if (exceptions.length && input.acceptExceptions !== true)
      throw error("RECOVERY_UNVERIFIED_ORIGINALS_REQUIRE_REVIEW", 409);
    // An owner must explicitly declare the affected control-data interval. This
    // preserves uncertainty; it cannot manufacture unknown post-snapshot holds.
    let controlDataLoss = null;
    if (input.controlDataLoss) {
      const { start, end, incidentReference } = input.controlDataLoss;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        !Number.isFinite(Date.parse(current.sourceCreatedAt)) ||
        start < Date.parse(current.sourceCreatedAt) ||
        end <= start ||
        end > store.now()
      )
        throw error("INVALID_RECOVERY_LOSS_INTERVAL");
      controlDataLoss = {
        start,
        end,
        incidentReference: reference(incidentReference),
      };
    }
    if (store.db.prepare("SELECT 1 FROM jobs WHERE state='running'").get())
      throw error("RECOVERY_STOP_WORKER_BEFORE_REVIEW", 409);
    if (
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE COALESCE(json_extract(payload,'$.kind'),'')!='archive-verify' AND state NOT IN ('complete','recovery-retired') AND NOT (state='blocked' AND COALESCE(error,'')='RECOVERY_REVIEW_REQUIRED')",
        )
        .get()
    )
      throw error("RECOVERY_UNREVIEWED_JOBS", 409);
    const plan = {
      id: crypto.randomUUID(),
      recoveryId: current.recoveryId,
      state: "reviewed",
      createdBy: actor.id,
      createdAt: store.now(),
      expiresAt: store.now() + TTL,
      references,
      controlDataLoss,
      exceptions: exceptions.map((s) => ({
        ...s,
        incidentReference: exceptionReference,
      })),
      jobs: current.jobs,
      activeHolds: current.activeHolds,
      fingerprint: fingerprint(store),
      productionReady: false,
    };
    store.put("recovery-reviews", plan.id, plan);
    store.audit(actor, "recovery.reviewed", {
      planId: plan.id,
      recoveryId: plan.recoveryId,
      references,
      controlDataLoss,
      exceptionCount: exceptions.length,
      fingerprint: plan.fingerprint,
    });
    return plan;
  });
}
function activate(store, actor, input) {
  return store.tx(() => {
    owner(store, actor);
    if (
      typeof input?.planId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.planId)
    )
      throw error("RECOVERY_REVIEW_NOT_FOUND", 404);
    const plan = store.get("recovery-reviews", input?.planId),
      control = store.get("recovery", "control");
    if (!plan || plan.createdBy !== actor.id || plan.recoveryId !== control?.id)
      throw error("RECOVERY_REVIEW_NOT_FOUND", 404);
    if (input.confirmation !== "ACTIVATE RECOVERY")
      throw error("RECOVERY_CONFIRMATION_REQUIRED");
    if (control.state === "released" && control.activation?.planId === plan.id)
      return control.activation;
    if (control.state !== "review-required" || plan.state !== "reviewed")
      throw error("RECOVERY_REVIEW_NOT_ACTIVE", 409);
    if (plan.expiresAt <= store.now() || plan.createdAt > store.now())
      throw error("RECOVERY_REVIEW_EXPIRED", 409);
    if (plan.fingerprint !== fingerprint(store))
      throw error("RECOVERY_REVIEW_STALE", 409);
    // Re-evaluate time-sensitive readback even if no database row changed.
    const assessed = assessment(store),
      accepted = new Set(plan.exceptions.map((s) => s.id));
    if (
      assessed.segments.some((s) => s.exceptionRequired && !accepted.has(s.id))
    )
      throw error("RECOVERY_READBACK_EXPIRED", 409);
    const counts = { resumed: 0, retiredRequests: 0, stillPaused: 0 };
    for (const job of plan.jobs) {
      if (job.action === "resume") {
        store.db
          .prepare(
            "UPDATE jobs SET state='queued',owner=NULL,lease=NULL,next=0,error=NULL WHERE id=?",
          )
          .run(job.id);
        counts.resumed++;
      } else if (job.action === "retire-request") {
        store.db
          .prepare(
            "UPDATE jobs SET state='recovery-retired',owner=NULL,lease=NULL,error='FRESH_REQUEST_REQUIRED' WHERE id=?",
          )
          .run(job.id);
        counts.retiredRequests++;
      } else counts.stillPaused++;
    }
    const activation = {
      planId: plan.id,
      activatedAt: store.now(),
      activatedBy: actor.id,
      counts,
      exceptionCount: plan.exceptions.length,
      controlDataLoss: plan.controlDataLoss,
      productionReady: false,
      restartWorkerRequired: true,
    };
    store.put("recovery", "control", {
      ...control,
      state: "released",
      activation,
      ownerAttestations: plan.references,
      postSnapshotChangesReconciled: false,
      newestSnapshotVerified: false,
      productionReady: false,
    });
    store.put("recovery-reviews", plan.id, {
      ...plan,
      state: "activated",
      activatedAt: activation.activatedAt,
    });
    store.audit(actor, "recovery.activated", {
      ...activation,
      recoveryId: control.id,
    });
    return activation;
  });
}
module.exports = { status, review, activate };
