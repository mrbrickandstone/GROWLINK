"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { digest, auditIntegrity } = require("./audit.cjs");
const { sqlRank, priority, QUEUE_INDEXES } = require("./queue-priority.cjs");
const { coverage, windowRange } = require("../../lib/security/coverage.cjs");
const DAY = 86400000,
  ROLES = ["owner", "operator", "technician", "auditor", "inspector"];
function error(code, status = 400) {
  return Object.assign(new Error(code), { status });
}
function text(value, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw error("INVALID_TEXT");
  return value.trim();
}
function range(w) {
  windowRange(w.start, w.end);
  return w;
}
class Store {
  constructor(root, { now = Date.now } = {}) {
    this.root = path.resolve(root);
    this.now = now;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Restored state must not revive stale grants, sessions or deletion approvals.
    try {
      fs.lstatSync(path.join(this.root, "RECOVERY_REQUIRED"));
      throw error("RECOVERY_REVALIDATION_REQUIRED", 409);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.db = new DatabaseSync(path.join(this.root, "command.sqlite"));
    fs.chmodSync(path.join(this.root, "command.sqlite"), 0o600);
    this.db.function("audit_hash", digest);
    this.db.function("job_rank", sqlRank);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,event TEXT NOT NULL,previous TEXT NOT NULL,hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,owner TEXT,lease INTEGER,next INTEGER NOT NULL DEFAULT 0,error TEXT);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
  `);
    for (const sql of Object.values(QUEUE_INDEXES))
      this.db.exec(sql.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "));
  }
  close() {
    this.db.close();
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(r.data) : null;
  }
  all(kind) {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(r.data));
  }
  put(kind, id, value) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }
  audit(actor, action, detail) {
    const event = JSON.stringify({
      at: this.now(),
      actor: actor.id,
      action,
      detail,
    });
    return this.db
      .prepare(
        "INSERT INTO audit(event,previous,hash) SELECT ?,head,audit_hash(head||char(10)||?) FROM (SELECT COALESCE((SELECT hash FROM audit ORDER BY seq DESC LIMIT 1),?) AS head) RETURNING hash",
      )
      .get(event, event, "0".repeat(64)).hash;
  }
  auditLog() {
    return this.db
      .prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 300")
      .all()
      .map((r) => ({ ...r, event: JSON.parse(r.event) }));
  }
  auditIntegrity() {
    return auditIntegrity(this.db);
  }
  user(id) {
    const u = this.get("users", id);
    return u?.enabled ? u : null;
  }
  registerUser(u) {
    if (
      !ROLES.includes(u.role) ||
      !Array.isArray(u.cameraIds) ||
      !u.cameraIds.length
    )
      throw error("INVALID_USER");
    u = {
      id: text(u.id, 500),
      name: text(u.name),
      role: u.role,
      cameraIds: u.cameraIds.map((x) => text(x)),
      enabled: u.enabled !== false,
    };
    return this.tx(() => {
      this.put("users", u.id, u);
      this.audit({ id: "local-administrator" }, "user.registered", {
        id: u.id,
        role: u.role,
      });
      return u;
    });
  }
  session(id, data, expires) {
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(digest(id), JSON.stringify(data), expires);
  }
  getSession(id) {
    if (!id) return null;
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id=? AND expires>?")
      .get(digest(id), this.now());
    return row ? JSON.parse(row.data) : null;
  }
  removeSession(id) {
    if (id) this.db.prepare("DELETE FROM sessions WHERE id=?").run(digest(id));
  }
  authorize(actor, action, cameraId, w) {
    if (!actor) throw error("SIGN_IN_REQUIRED", 401);
    if (actor.externalAuthenticated) {
      const user = this.user(actor.id);
      if (!user) throw error("USER_DISABLED", 403);
      actor = { ...actor, ...user };
    }
    if (actor.role === "owner" && !actor.mfa)
      throw error("OWNER_MFA_REQUIRED", 403);
    if (actor.readOnly && !["read", "playback"].includes(action))
      throw error("REVIEW_IS_READ_ONLY", 403);
    const perms = {
      owner: [
        "read",
        "playback",
        "export",
        "configure",
        "hold",
        "release",
        "grant",
        "record",
        "delete",
      ],
      operator: ["read", "playback", "export", "hold", "record"],
      technician: ["read", "configure", "record"],
      auditor: ["read"],
      inspector: ["read", "playback", "export"],
    };
    if (!perms[actor.role]?.includes(action)) throw error("ROLE_DENIED", 403);
    if (cameraId && !actor.cameraIds?.some((x) => x === "*" || x === cameraId))
      throw error("CAMERA_SCOPE_DENIED", 403);
    if (actor.role === "inspector") {
      const grants = this.all("grants").filter(
        (g) =>
          g.userId === actor.id &&
          !g.revokedAt &&
          g.expiresAt > this.now() &&
          g.cameraIds.includes(cameraId) &&
          (!w || (w.start >= g.start && w.end <= g.end)),
      );
      if (!grants.length) throw error("REQUEST_GRANT_REQUIRED", 403);
      if (
        ["playback", "export"].includes(action) &&
        this.get("cameras", cameraId)?.source === "ring" &&
        !this.get("policy", "ring")?.inspectorApproved
      )
        throw error("RING_INSPECTOR_POLICY_UNRESOLVED", 403);
    }
    return true;
  }
  visibleCameras(actor) {
    return this.all("cameras")
      .filter((c) => {
        try {
          return this.authorize(actor, "read", c.id);
        } catch {
          return false;
        }
      })
      .map((c) => {
        const { providerId, ...safe } = c;
        return safe;
      });
  }
  cameraStatus(actor, c) {
    const readback =
      actor.role === "inspector" ? null : this.get("verification-health", c.id);
    const seg = this.all("segments")
      .filter((s) => s.cameraId === c.id && s.verified && !s.deletedAt)
      .filter((s) => {
        if (actor.role !== "inspector") return true;
        try {
          return this.authorize(actor, "playback", c.id, {
            start: s.start,
            end: s.end,
          });
        } catch {
          return false;
        }
      });
    const newest = seg.reduce((n, s) => Math.max(n, s.end), 0),
      archived = seg.filter(
        (s) => s.receipt?.independent && s.receipt.readbackVerifiedAt,
      );
    const capture = !newest
      ? { state: "unknown", detail: "No verified recorded frames" }
      : this.now() - newest > 120000
        ? { state: "stale", detail: "Latest verified footage is historical" }
        : {
            state: "verified",
            detail:
              "Recent exported frames; source qualification still pending",
          };
    const required = coverage(
      this.now() - 60 * DAY,
      this.now(),
      archived.map((s) => ({
        start: s.start,
        end: s.end,
        verified:
          s.receipt.immutableStorageVerified &&
          s.receipt.retainUntil >= this.now(),
      })),
    );
    let access;
    try {
      this.authorize(actor, "playback", c.id);
      const observation = this.get("access", actor.id + "|" + c.id);
      const verified =
        !actor.readOnly && observation && this.now() - observation.at < 300000;
      access = {
        state: verified ? "verified" : "unknown",
        detail: actor.readOnly
          ? "Local review only; named access not commissioned"
          : verified
            ? "Recent authenticated playback delivery; scope rechecked per request"
            : "Role permits access; successful recent playback not verified",
      };
    } catch {
      access = {
        state: "failed",
        detail: "Current role or policy does not permit playback",
      };
    }
    return {
      ...c,
      media: {
        count: seg.length,
        earliest: seg.length
          ? Math.min(...seg.map((s) => s.requested.start))
          : null,
        latest: newest || null,
        bytes: seg.reduce((n, s) => n + s.bytes, 0),
        thumbnailId:
          seg.filter((s) => s.derivative).sort((a, b) => b.end - a.end)[0]
            ?.id || null,
      },
      capture: { ...capture, observedAt: newest || null },
      archive: {
        state: readback?.failed
          ? "failed"
          : readback?.overdue
            ? "degraded"
            : archived.length
              ? "degraded"
              : "unknown",
        detail: readback?.failed
          ? `${readback.missing} missing, ${readback.mismatch} mismatched, ${readback.unavailable} unreadable archive copies; affected coverage is unverified`
          : readback?.overdue
            ? "Scheduled full-byte archive checks are overdue"
            : archived.length
              ? "Verified objects exist; full continuity not commissioned"
              : "Independent archive not verified",
        ...(readback ? { readback } : {}),
      },
      retention: {
        state: required.gaps.length ? "degraded" : "verified",
        detail: required.gaps.length
          ? "60-day coverage not established"
          : "60-day verified protected coverage",
        targetDays: 90,
        minimumDays: 60,
      },
      access,
    };
  }
  timeline(actor, cameraId, start, end) {
    range({ start, end });
    if (end - start > 31 * DAY) throw error("WINDOW_TOO_LARGE");
    this.authorize(actor, "read", cameraId, { start, end });
    const segments = this.all("segments")
      .filter(
        (s) =>
          s.cameraId === cameraId &&
          !s.deletedAt &&
          s.end > start &&
          s.start < end,
      )
      .filter((s) => {
        try {
          return this.authorize(actor, "playback", cameraId, {
            start: s.start,
            end: s.end,
          });
        } catch {
          return false;
        }
      })
      .map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        requested: s.requested,
        verified: s.verified,
        sha256: s.sha256,
        bytes: s.bytes,
        provenance: s.provenance,
        derivativeReady: this.playbackReady(s),
        independent: !!s.receipt?.independent,
      }));
    return {
      cameraId,
      start,
      end,
      segments,
      ...coverage(start, end, segments),
    };
  }
  configureCamera(actor, input) {
    const old = this.get("cameras", input.id);
    if (!old) throw error("CAMERA_NOT_FOUND", 404);
    this.authorize(actor, "configure", old.id);
    return this.tx(() => {
      const c = {
        ...old,
        location: text(input.location),
        room: text(input.room),
        name: text(input.name),
        updatedAt: this.now(),
      };
      this.put("cameras", c.id, c);
      this.audit(actor, "camera.mapped", {
        cameraId: c.id,
        location: c.location,
        room: c.room,
        name: c.name,
      });
      return c;
    });
  }
  addHold(actor, input) {
    range(input);
    this.authorize(actor, "hold", input.cameraId, input);
    if (!this.get("cameras", input.cameraId))
      throw error("CAMERA_NOT_FOUND", 404);
    return this.tx(() => {
      const hold = {
        id: crypto.randomUUID(),
        cameraId: input.cameraId,
        start: input.start,
        end: input.end,
        caseReference: text(input.caseReference),
        reason: text(input.reason, 2000),
        createdBy: actor.id,
        createdAt: this.now(),
        state: "pending",
        nativePreservation: "unverified",
      };
      this.put("holds", hold.id, hold);
      this.audit(actor, "hold.created", hold);
      return hold;
    });
  }
  releaseHold(actor, id, reason) {
    this.authorize(actor, "release");
    return this.tx(() => {
      const h = this.get("holds", id);
      if (!h) throw error("HOLD_NOT_FOUND", 404);
      this.authorize(actor, "release", h.cameraId);
      h.state = "released";
      h.releasedBy = actor.id;
      h.releasedAt = this.now();
      h.releaseReason = text(reason, 2000);
      this.put("holds", id, h);
      this.audit(actor, "hold.released", h);
      return h;
    });
  }
  held(segment) {
    return this.all("holds").filter(
      (h) =>
        h.cameraId === segment.cameraId &&
        h.state !== "released" &&
        h.start < segment.end &&
        h.end > segment.start,
    );
  }
  grant(actor, input) {
    this.authorize(actor, "grant");
    range(input);
    const user = this.user(input.userId);
    if (
      user?.role !== "inspector" ||
      !Array.isArray(input.cameraIds) ||
      !input.cameraIds.length ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.now() ||
      input.expiresAt > this.now() + 7 * DAY
    )
      throw error("INVALID_INSPECTOR_GRANT");
    for (const id of input.cameraIds) {
      this.authorize(actor, "grant", id);
      const c = this.get("cameras", id);
      if (!c) throw error("CAMERA_NOT_FOUND", 404);
      if (c.source === "ring" && !this.get("policy", "ring")?.inspectorApproved)
        throw error("RING_INSPECTOR_POLICY_UNRESOLVED", 409);
    }
    return this.tx(() => {
      const g = {
        id: crypto.randomUUID(),
        userId: user.id,
        requestId: text(input.requestId),
        purpose: text(input.purpose, 2000),
        cameraIds: [...new Set(input.cameraIds)],
        start: input.start,
        end: input.end,
        expiresAt: input.expiresAt,
        approvedBy: actor.id,
        consentRecordedAt: this.now(),
        ownerNotifiedAt: this.now(),
        revokedAt: null,
      };
      this.put("grants", g.id, g);
      this.audit(actor, "grant.created", g);
      return g;
    });
  }
  revoke(actor, id) {
    this.authorize(actor, "grant");
    return this.tx(() => {
      const g = this.get("grants", id);
      if (!g) throw error("GRANT_NOT_FOUND", 404);
      for (const c of g.cameraIds) this.authorize(actor, "grant", c);
      g.revokedAt = this.now();
      this.put("grants", id, g);
      this.audit(actor, "grant.revoked", { id });
      return g;
    });
  }
  record(actor, input) {
    this.authorize(actor, "record");
    if (
      !["inspection", "power"].includes(input.kind) ||
      !Number.isSafeInteger(input.performedAt) ||
      input.performedAt > this.now()
    )
      throw error("INVALID_RECORD");
    const cameraIds = input.cameraIds;
    if (!Array.isArray(cameraIds) || !cameraIds.length)
      throw error("CAMERAS_REQUIRED");
    for (const id of cameraIds) {
      this.authorize(actor, "record", id);
      if (!this.get("cameras", id)) throw error("CAMERA_NOT_FOUND", 404);
    }
    const r = {
      id: crypto.randomUUID(),
      kind: input.kind,
      performedAt: input.performedAt,
      cameraIds,
      performedBy: actor.id,
      notes: text(input.notes, 4000),
      evidenceReference: text(input.evidenceReference, 1000),
      createdAt: this.now(),
      retainUntil: this.now() + Math.ceil(365.25 * 5) * DAY,
    };
    if (input.kind === "inspection") {
      if (!["pass", "defects", "incomplete"].includes(input.result))
        throw error("INVALID_RESULT");
      r.result = input.result;
      r.nextDueAt = input.performedAt + 30 * DAY;
    } else {
      if (
        !Number.isFinite(input.loadWatts) ||
        input.loadWatts <= 0 ||
        !Number.isFinite(input.runtimeMinutes) ||
        input.runtimeMinutes < 0 ||
        input.runtimeMinutes > 7 * 1440 ||
        input.runtimeMinutes * 60000 > this.now() - input.performedAt
      )
        throw error("INVALID_POWER_MEASUREMENT");
      r.loadWatts = input.loadWatts;
      r.runtimeMinutes = input.runtimeMinutes;
      r.equipment = text(input.equipment, 1000);
      r.continuityVerified = input.continuityVerified === true;
      r.result =
        r.runtimeMinutes >= 480 && r.continuityVerified
          ? "recorded-eight-hour-test"
          : "incomplete";
    }
    return this.tx(() => {
      this.put("records", r.id, r);
      this.audit(actor, "commissioning.recorded", r);
      return r;
    });
  }
  deleteEligibility(s) {
    const reasons = [];
    if (!s || s.deletedAt) return ["NOT_AVAILABLE"];
    if (this.held(s).length) reasons.push("INVESTIGATION_HOLD");
    if (
      s.receipt?.objectKey &&
      this.all("segments").some(
        (other) =>
          other.id !== s.id &&
          !other.deletedAt &&
          other.receipt?.objectKey === s.receipt.objectKey &&
          other.receipt?.versionId === s.receipt.versionId,
      )
    )
      reasons.push("SHARED_ARCHIVE_OBJECT_REQUIRES_GROUP_REVIEW");
    if (
      this.now() <
      Math.max(
        s.ingestedAt + 90 * DAY,
        s.end + 60 * DAY,
        s.receipt?.retainUntil || Infinity,
      )
    )
      reasons.push("RETENTION_ACTIVE_OR_UNKNOWN");
    if (!s.receipt?.independent || !s.receipt.immutableStorageVerified)
      reasons.push("ARCHIVE_PROTECTION_UNVERIFIED");
    if (s.source === "ring" && !this.get("policy", "ring")?.retentionApproved)
      reasons.push("RING_RETENTION_POLICY_UNRESOLVED");
    return reasons;
  }
  requestDelete(actor, id, reason) {
    const s = this.get("segments", id);
    if (!s) throw error("SEGMENT_NOT_FOUND", 404);
    this.authorize(actor, "delete", s.cameraId);
    return this.tx(() => {
      const r = {
        id: crypto.randomUUID(),
        segmentId: id,
        requestedBy: actor.id,
        reason: text(reason, 2000),
        requestedAt: this.now(),
        state: "requested",
        blockers: this.deleteEligibility(s),
      };
      this.put("deletions", r.id, r);
      this.audit(actor, "deletion.requested", r);
      return r;
    });
  }
  approveDelete(actor, id) {
    this.authorize(actor, "delete");
    return this.tx(() => {
      const r = this.get("deletions", id);
      if (!r || r.state !== "requested") throw error("DELETION_NOT_PENDING");
      const s = this.get("segments", r.segmentId);
      this.authorize(actor, "delete", s.cameraId);
      if (r.requestedBy === actor.id)
        throw error("SECOND_NAMED_APPROVER_REQUIRED", 403);
      const blockers = this.deleteEligibility(s);
      if (blockers.length) throw error(blockers.join(","), 409);
      r.state = "approved";
      r.approvedBy = actor.id;
      r.approvedAt = this.now();
      this.put("deletions", id, r);
      this.audit(actor, "deletion.approved", r);
      return r;
    });
  }
  enqueue(payload) {
    const id = digest(JSON.stringify(payload));
    this.db
      .prepare("INSERT OR IGNORE INTO jobs(id,payload) VALUES(?,?)")
      .run(id, JSON.stringify(payload));
    return id;
  }
  playbackReady(s) {
    if (
      !s?.verified ||
      s.deletedAt ||
      !/^[a-f0-9]{64}$/.test(s.id) ||
      s.derivative?.video !== s.id + ".mp4"
    )
      return false;
    try {
      return fs
        .lstatSync(path.join(this.root, "derivatives", s.derivative.video))
        .isFile();
    } catch {
      return false;
    }
  }
  claim({ verificationOnly = false } = {}) {
    const now = this.now(),
      owner = crypto.randomUUID();
    return this.tx(() => {
      const j = this.db
        .prepare(
          `UPDATE jobs SET state='running',owner=?,lease=?,attempts=attempts+1 WHERE id=(
          SELECT j.id FROM jobs j
          LEFT JOIN records s ON s.kind='segments' AND s.id=COALESCE(json_extract(j.payload,'$.segmentId'),j.id)
          LEFT JOIN records c ON c.kind='cameras' AND c.id=json_extract(j.payload,'$.cameraId')
          WHERE ((j.state='queued' AND j.next<=?) OR (j.state='running' AND j.lease<=?))
          AND (?=0 OR json_extract(j.payload,'$.kind')='archive-verify')
          AND NOT EXISTS (SELECT 1 FROM jobs other WHERE other.id!=j.id AND other.state='running' AND other.lease>? AND COALESCE(json_extract(other.payload,'$.segmentId'),other.id)=COALESCE(json_extract(j.payload,'$.segmentId'),j.id))
          ORDER BY job_rank(j.payload,s.data,c.data,?), j.rowid LIMIT 1
        ) RETURNING *`,
        )
        .get(owner, now + 600000, now, now, verificationOnly ? 1 : 0, now, now);
      if (!j) return null;
      const payload = JSON.parse(j.payload),
        dispatch = priority(
          payload,
          this.get("segments", payload.segmentId || j.id),
          this.get("cameras", payload.cameraId || ""),
          now,
        );
      this.put("job-dispatch", j.id, {
        jobId: j.id,
        at: now,
        attempt: j.attempts,
        ...dispatch,
      });
      return { ...j, payload };
    });
  }
  finish(j, state, code = null, nextAt) {
    const r = this.db
      .prepare(
        "UPDATE jobs SET state=?,error=?,next=?,lease=NULL,owner=NULL WHERE id=? AND owner=? AND state='running'",
      )
      .run(
        state,
        code,
        nextAt ??
          this.now() + Math.min(300000, 15000 * 2 ** Math.min(j.attempts, 5)),
        j.id,
        j.owner,
      );
    if (r.changes !== 1) throw error("LEASE_LOST", 409);
  }
  renew(job) {
    const r = this.db
      .prepare(
        "UPDATE jobs SET lease=? WHERE id=? AND owner=? AND state='running'",
      )
      .run(this.now() + 600000, job.id, job.owner);
    if (r.changes !== 1) throw error("LEASE_LOST", 409);
  }
  deferForCapacity(job, code) {
    if (!["DISK_SPACE_LOW", "DISK_CAPACITY_UNKNOWN"].includes(code))
      throw error("INVALID_CAPACITY_DEFERRAL");
    const r = this.db
      .prepare(
        "UPDATE jobs SET state='queued',error=?,next=?,lease=NULL,owner=NULL,attempts=MAX(0,attempts-1) WHERE id=? AND owner=? AND state='running'",
      )
      .run(code, this.now() + 30000, job.id, job.owner);
    if (r.changes !== 1) throw error("LEASE_LOST", 409);
  }
  jobs() {
    return this.db
      .prepare(
        "SELECT id,state,attempts,error,next FROM jobs ORDER BY rowid DESC LIMIT 100",
      )
      .all();
  }
  heartbeat(component, detail) {
    this.put("heartbeats", component, { component, at: this.now(), ...detail });
  }
}
module.exports = { Store, DAY, digest, error, text, range, ROLES };
