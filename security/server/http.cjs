"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { createAuth } = require("./auth.cjs");
const { error } = require("./store.cjs");
const { queueEvidence } = require("./evidence.cjs");
const recoveryActivation = require("./recovery-activation.cjs");
const PUBLIC = path.resolve(__dirname, "../public");
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw error("JSON_REQUIRED", 415);
  let n = 0,
    s = "";
  for await (const c of req) {
    n += c.length;
    if (n > 32768) throw error("REQUEST_TOO_LARGE", 413);
    s += c;
  }
  try {
    return JSON.parse(s);
  } catch {
    throw error("INVALID_JSON");
  }
}
function createServer({
  store,
  archive,
  env = process.env,
  origin,
  review = false,
  authenticate,
}) {
  const auth = createAuth(store, env, origin);
  if (env.SECURITY_HEALTH_TOKEN && env.SECURITY_HEALTH_TOKEN.length < 32)
    throw error("HEALTH_TOKEN_REQUIRED", 503);
  const reviewActor = {
    id: "local-read-only-review",
    name: "Local review",
    role: "operator",
    cameraIds: ["*"],
    readOnly: true,
    mfa: false,
  };
  if (review && !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
    throw error("REVIEW_REQUIRES_LOOPBACK");
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    let actor;
    try {
      if (req.headers.host !== new URL(origin).host)
        throw error("HOST_DENIED", 403);
      if (
        req.headers["sec-fetch-site"] === "cross-site" &&
        !(req.url || "").startsWith("/auth/callback")
      )
        throw error("CROSS_SITE_REQUEST_DENIED", 403);
      const url = new URL(req.url, origin),
        route = url.pathname;
      if (route === "/healthz/ready" && req.method === "GET") {
        if (!env.SECURITY_HEALTH_TOKEN) throw error("NOT_FOUND", 404);
        const { timingEqual } = require("./watchdog.cjs");
        if (
          !timingEqual(
            req.headers.authorization,
            "Bearer " + env.SECURITY_HEALTH_TOKEN,
          )
        )
          throw error("HEALTH_ACCESS_DENIED", 401);
        const result = require("./health.cjs").readiness(store, {
          nonce: url.searchParams.get("nonce"),
          token: env.SECURITY_HEALTH_TOKEN,
          signInConfigured: !review && auth.configured,
        });
        return json(
          res,
          result.payload.databaseReadable && result.payload.signInConfigured
            ? 200
            : 503,
          result,
        );
      }
      if (route === "/healthz" && req.method === "GET")
        return json(res, 200, {
          service: "farber-security-control",
          now: store.now(),
          recordingControlledByDashboard: false,
        });
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(route)
      ) {
        const file = path.join(
          PUBLIC,
          route === "/" ? "index.html" : route.slice(1),
        );
        res.setHeader(
          "Content-Type",
          route.endsWith(".js")
            ? "text/javascript"
            : route.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        return await pipeline(fs.createReadStream(file), res);
      }
      if (route === "/auth/login" && req.method === "GET") {
        if (review) throw error("REVIEW_IS_READ_ONLY", 403);
        return await auth.login(req, res);
      }
      if (route === "/auth/callback" && req.method === "GET") {
        if (review) throw error("REVIEW_IS_READ_ONLY", 403);
        return await auth.callback(req, res, url);
      }
      actor = authenticate
        ? await authenticate(req)
        : review
          ? reviewActor
          : auth.principal(req);
      if (route === "/api/session" && req.method === "GET")
        return json(res, 200, {
          user: actor
            ? {
                id: actor.id,
                name: actor.name,
                role: actor.role,
                readOnly: !!actor.readOnly,
                csrf: actor.csrf,
              }
            : null,
          signInConfigured: auth.configured,
          review,
        });
      if (!actor) throw error("SIGN_IN_REQUIRED", 401);
      if (req.method !== "GET") {
        if (review) throw error("REVIEW_IS_READ_ONLY", 403);
        auth.checkWrite(req, actor);
        if (!store.auditIntegrity().valid)
          throw error("AUDIT_INTEGRITY_FAILED", 409);
      }
      if (route === "/api/logout" && req.method === "POST") {
        auth.logout(req, res);
        store.audit(actor, "session.ended", {});
        return json(res, 200, { ok: true });
      }
      if (route === "/api/recovery" && req.method === "GET")
        return json(res, 200, recoveryActivation.status(store, actor));
      if (route === "/api/overview" && req.method === "GET") {
        const cameras = store
            .visibleCameras(actor)
            .map((c) => store.cameraStatus(actor, c)),
          ids = cameras.map((c) => c.id),
          inspector = actor.role === "inspector";
        return json(res, 200, {
          cameras,
          recovery: {
            pending: store.recoveryPending(),
            prepared: !!store.get("recovery", "control"),
          },
          holds: inspector
            ? []
            : store.all("holds").filter((h) => ids.includes(h.cameraId)),
          grants: store
            .all("grants")
            .filter((g) => actor.role === "owner" || g.userId === actor.id),
          records: inspector
            ? []
            : store
                .all("records")
                .filter((r) => r.cameraIds.every((id) => ids.includes(id))),
          deletions: actor.role === "owner" ? store.all("deletions") : [],
          jobs: inspector ? [] : store.jobs(),
          heartbeats: inspector ? [] : store.all("heartbeats"),
          pipelineHealth: inspector
            ? []
            : store
                .all("pipeline-health")
                .filter((row) => ids.includes(row.cameraId)),
          users:
            actor.role === "owner"
              ? store.all("users").map(({ id, name, role, enabled }) => ({
                  id,
                  name,
                  role,
                  enabled,
                }))
              : [],
          audit: ["owner", "auditor"].includes(actor.role)
            ? store.auditLog()
            : [],
          auditIntegrity: inspector ? null : store.auditIntegrity(),
          exports: store
            .all("exports")
            .filter((e) => e.createdBy === actor.id)
            .map((e) => ({
              id: e.id,
              state: e.state,
              requestId: e.requestId || JSON.parse(e.manifestText).requestId,
              createdAt: e.createdAt,
            })),
          policy: {
            ring: store.get("policy", "ring") || { status: "unresolved" },
            archive: archive.independent
              ? "Independent destination configured; receipts govern status"
              : "Local development copy; independent archive not configured",
            targetDays: 90,
            minimumDays: 60,
            compliance: "Not commissioned; no OCM compliance assertion",
          },
          now: store.now(),
        });
      }
      if (route === "/api/timeline" && req.method === "GET")
        return json(
          res,
          200,
          store.timeline(
            actor,
            url.searchParams.get("camera"),
            Number(url.searchParams.get("start")),
            Number(url.searchParams.get("end")),
          ),
        );
      const playbackStatus = route.match(
        /^\/api\/playback\/([a-f0-9]{64})\/status$/,
      );
      if (playbackStatus && req.method === "GET")
        return json(
          res,
          200,
          require("./playback.cjs").playbackStatus(
            store,
            actor,
            playbackStatus[1],
          ),
        );
      const media = route.match(
        /^\/api\/media\/([a-f0-9]{64})\/(playback|thumbnail|original)$/,
      );
      if (media && req.method === "GET") {
        const [, id, kind] = media,
          s = store.get("segments", id);
        if (!s || s.deletedAt || !s.verified)
          throw error("MEDIA_NOT_VERIFIED", 404);
        const action = kind === "original" ? "export" : "playback";
        const check = () => {
          const current = store.get("segments", id);
          if (!current?.verified || current.deletedAt)
            throw error("MEDIA_WITHDRAWN", 403);
          store.authorize(actor, action, s.cameraId, {
            start: s.start,
            end: s.end,
          });
          if (!review && !authenticate && !auth.principal(req))
            throw error("SESSION_EXPIRED", 401);
        };
        check();
        if (kind === "original") {
          const exportRecord = store.get(
            "exports",
            url.searchParams.get("export"),
          );
          if (
            !exportRecord ||
            exportRecord.state !== "complete" ||
            exportRecord.recoverySuspendedAt ||
            exportRecord.createdBy !== actor.id ||
            !exportRecord.segmentIds?.includes(id)
          )
            throw error("REQUEST_SPECIFIC_EXPORT_REQUIRED", 403);
          if (!(await archive.verify(s.receipt)))
            throw error("EVIDENCE_READBACK_FAILED", 409);
          check();
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${s.sha256}.mp4"`,
          );
          res.setHeader("Content-Length", s.bytes);
          store.audit(actor, "evidence.original.download", {
            segmentId: id,
            exportId: exportRecord.id,
          });
          const stream = await archive.read(s.receipt);
          const timer = setInterval(() => {
            try {
              check();
            } catch {
              stream.destroy();
              res.destroy();
            }
          }, 1000);
          timer.unref();
          try {
            return await pipeline(stream, res);
          } finally {
            clearInterval(timer);
          }
        }
        const filename =
          s.derivative?.[kind === "thumbnail" ? "image" : "video"];
        if (!filename) throw error("PLAYBACK_COPY_NOT_READY", 409);
        if (!/^[a-f0-9]{64}\.(mp4|jpg)$/.test(filename))
          throw error("INVALID_MEDIA_REFERENCE", 500);
        const file = path.join(store.root, "derivatives", filename);
        let size;
        store.tx(() => {
          check();
          try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile()) throw error("INVALID_MEDIA_REFERENCE", 500);
            size = stat.size;
          } catch (e) {
            if (e.code === "ENOENT")
              throw error("PLAYBACK_COPY_NOT_READY", 409);
            throw e;
          }
          if (kind === "playback")
            store.put("cache-access", id, { at: store.now() });
        });
        let start = 0,
          end = size - 1,
          status = 200;
        if (req.headers.range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!m) throw error("INVALID_RANGE", 416);
          start = Number(m[1]);
          end = m[2] ? Number(m[2]) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            end >= size
          )
            throw error("INVALID_RANGE", 416);
          status = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader(
          "Content-Type",
          kind === "thumbnail" ? "image/jpeg" : "video/mp4",
        );
        res.setHeader("Content-Length", end - start + 1);
        res.statusCode = status;
        store.audit(actor, "media.viewed", {
          segmentId: id,
          kind,
          range: { start, end },
        });
        const stream = fs.createReadStream(file, { start, end });
        const timer = setInterval(() => {
          try {
            check();
          } catch {
            stream.destroy();
            res.destroy();
          }
        }, 1000);
        timer.unref();
        try {
          await pipeline(stream, res);
          if (kind === "playback")
            store.put("access", actor.id + "|" + s.cameraId, {
              at: store.now(),
              segmentId: id,
            });
          return;
        } finally {
          clearInterval(timer);
        }
      }
      const exportStatus = route.match(
        /^\/api\/exports\/([a-f0-9-]{36})\/status$/,
      );
      if (exportStatus && req.method === "GET") {
        const r = store.get("exports", exportStatus[1]);
        if (!r || r.createdBy !== actor.id)
          throw error("EXPORT_NOT_FOUND", 404);
        store.authorize(actor, "export", r.cameraId, {
          start: r.start,
          end: r.end,
        });
        for (const id of r.segmentIds || []) {
          const s = store.get("segments", id);
          if (!s) throw error("EXPORT_SOURCE_UNAVAILABLE", 409);
          store.authorize(actor, "export", s.cameraId, {
            start: s.start,
            end: s.end,
          });
        }
        return json(res, 200, r);
      }
      const exportDownload = route.match(/^\/api\/exports\/([a-f0-9-]{36})$/);
      if (exportDownload && req.method === "GET") {
        const r = store.get("exports", exportDownload[1]);
        if (!r || r.createdBy !== actor.id)
          throw error("EXPORT_NOT_FOUND", 404);
        if (r.state !== "complete") throw error("EXPORT_NOT_READY", 409);
        store.authorize(actor, "export", r.cameraId, {
          start: r.start,
          end: r.end,
        });
        for (const id of r.segmentIds) {
          const s = store.get("segments", id);
          store.authorize(actor, "export", s.cameraId, {
            start: s.start,
            end: s.end,
          });
        }
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="farber-evidence-${r.id}.json"`,
        );
        return json(res, 200, {
          manifestText: r.manifestText,
          signature: r.signature,
          publicKey: r.publicKey,
          verification:
            "Verify Ed25519 signature over exact UTF-8 manifestText. Trust the public-key fingerprint through a separate channel.",
        });
      }
      if (req.method === "POST") {
        const input = await body(req);
        let value;
        if (route === "/api/recovery/review")
          value = recoveryActivation.review(store, actor, input);
        else if (route === "/api/recovery/activate")
          value = recoveryActivation.activate(store, actor, input);
        else if (route === "/api/playback/prepare") {
          value = require("./playback.cjs").queuePlayback(
            store,
            actor,
            input.segmentId,
          );
          return json(res, value.state === "ready" ? 200 : 202, value);
        } else if (route === "/api/cameras")
          value = store.configureCamera(actor, input);
        else if (route === "/api/holds") value = store.addHold(actor, input);
        else if (route === "/api/holds/release")
          value = store.releaseHold(actor, input.id, input.reason);
        else if (route === "/api/grants") value = store.grant(actor, input);
        else if (route === "/api/grants/revoke")
          value = store.revoke(actor, input.id);
        else if (route === "/api/records") value = store.record(actor, input);
        else if (route === "/api/deletions")
          value = store.requestDelete(actor, input.segmentId, input.reason);
        else if (route === "/api/deletions/approve")
          value = store.approveDelete(actor, input.id);
        else if (route === "/api/exports") {
          value = queueEvidence(store, actor, input);
          return json(res, 202, value);
        } else throw error("NOT_FOUND", 404);
        return json(res, 201, value);
      }
      throw error("NOT_FOUND", 404);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const code = /^[A-Z_0-9,]+$/.test(e.message)
        ? e.message
        : "REQUEST_FAILED";
      if (actor && e.status === 403)
        try {
          store.audit(actor, "access.denied", { code });
        } catch {}
      json(res, e.status || 500, { error: code });
    }
  });
  return server;
}
module.exports = { createServer };
