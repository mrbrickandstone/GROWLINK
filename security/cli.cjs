"use strict";
process.umask(0o077);
const fs = require("node:fs"),
  path = require("node:path");
const { Store, error } = require("./server/store.cjs");
const { hashFile } = require("../lib/security/ring-pilot.cjs");
const store = new Store(
  process.env.SECURITY_DATA_DIR || path.join(__dirname, "../.security"),
);
(async () => {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "import-pilot") {
    const repo = path.resolve(__dirname, "..");
    const actor = { id: "local-pilot-import" };
    const site = require("./site.json");
    for (const c of site.cameras) {
      if (!store.get("cameras", c.id))
        store.put("cameras", c.id, {
          ...c,
          source: "ring",
          location: site.location,
          mappingEvidence: site.mappingEvidence,
          sourceQualified: false,
          exportEnabled: false,
          configurationEvidence: "2026-10-13-cloud-inspection.json",
        });
    }
    let count = 0;
    for (const run of [
      "media-smoke",
      "media-five-minute",
      "media-crash",
      "media-overlap",
    ]) {
      const root = path.join(repo, ".pilot", run),
        r = JSON.parse(fs.readFileSync(path.join(root, "report.json")));
      for (const j of r.jobs) {
        const m = j.result?.media,
          a = j.result?.assessment;
        if (!m || !a?.verified) throw error("UNVERIFIED_PILOT_RECORD");
        const f = path.resolve(root, m.file);
        if (!f.startsWith(root + path.sep) || (await hashFile(f)) !== m.sha256)
          throw error("PILOT_ORIGINAL_MISMATCH");
        store.enqueue({
          kind: "pilot-import",
          cameraId: "ring-1",
          file: f,
          sha256: m.sha256,
          size: m.size,
          requestStart: j.request.start,
          requestEnd: j.request.end,
          actualStart: a.actualStart,
        });
        count++;
      }
    }
    store.audit(actor, "pilot.import.queued", { count });
    console.log(
      JSON.stringify({
        queued: count,
        roomMapping: "Owner-supplied rooms from site.json",
        independentArchive: false,
      }),
    );
  } else if (cmd === "add-user") {
    store.registerUser(JSON.parse(fs.readFileSync(file)));
    console.log("Named user provisioned. No credentials printed.");
  } else if (cmd === "configure-ring") {
    const config = JSON.parse(fs.readFileSync(file));
    if (
      [
        "automatedExportsApproved",
        "retentionApproved",
        "inspectorApproved",
      ].some((k) => config.policy?.[k] === true) &&
      !config.policy?.decisionReference?.trim()
    )
      throw error("POLICY_EVIDENCE_REQUIRED");
    store.tx(() => {
      store.put("policy", "ring", config.policy || { status: "unresolved" });
      for (const c of config.cameras || []) {
        const old = store.get("cameras", c.id);
        if (
          !old ||
          typeof c.providerId !== "string" ||
          !c.providerId.startsWith("ava1.") ||
          !Number.isSafeInteger(c.enabledAt)
        )
          throw error("INVALID_RING_CAMERA");
        store.put("cameras", c.id, {
          ...old,
          providerId: c.providerId,
          enabledAt: c.enabledAt,
          exportEnabled: c.exportEnabled === true,
        });
      }
      store.audit({ id: "local-administrator" }, "ring.configuration.changed", {
        decisionReference: config.policy?.decisionReference || null,
      });
    });
    console.log("Ring worker configuration saved; no credentials printed.");
  } else throw error("USE_IMPORT_PILOT_ADD_USER_OR_CONFIGURE_RING");
})()
  .catch((e) => {
    console.error(
      /^[A-Z_0-9]+$/.test(e.message) ? e.message : "COMMAND_FAILED",
    );
    process.exitCode = 1;
  })
  .finally(() => store.close());
