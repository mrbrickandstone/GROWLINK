"use strict";
const { error } = require("./store.cjs");
const fs = require("node:fs"),
  path = require("node:path");
function removeManagedCopies(store, s) {
  if (!/^[a-f0-9]{64}$/.test(s.id)) throw error("INVALID_SEGMENT_ID");
  const files = [
    path.join(store.root, "derivatives", s.id + ".mp4"),
    path.join(store.root, "derivatives", s.id + ".jpg"),
    path.join(store.root, "staging", s.id + ".resume.mp4"),
  ];
  const dir = path.join(store.root, "staging", "originals");
  if (fs.existsSync(dir))
    for (const name of fs.readdirSync(dir))
      if (
        name.startsWith(s.id + ".") &&
        /^[a-f0-9]{64}\.[a-f0-9]{64}\.mp4$/.test(name)
      )
        files.push(path.join(dir, name));
  for (const file of files)
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
}
async function executeDeletion(store, archive, id) {
  // The worker owns this transaction on its own connection. A concurrent hold must
  // commit before this lock to precede deletion; contention is reported, never hidden.
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const request = store.get("deletions", id);
    if (
      !request ||
      request.state !== "approved" ||
      request.requestedBy === request.approvedBy
    )
      throw error("TWO_OWNER_APPROVAL_REQUIRED", 409);
    if (
      ![request.requestedBy, request.approvedBy].every(
        (u) => store.user(u)?.role === "owner",
      )
    )
      throw error("APPROVER_ACCESS_CHANGED", 409);
    const s = store.get("segments", request.segmentId),
      blockers = store.deleteEligibility(s);
    if (blockers.length) throw error(blockers.join(","), 409);
    await archive.remove(s.receipt);
    removeManagedCopies(store, s);
    store.put("segments", s.id, {
      ...s,
      deletedAt: store.now(),
      verified: false,
      derivative: null,
    });
    store.put("deletions", id, {
      ...request,
      state: "deleted",
      deletedAt: store.now(),
    });
    store.audit({ id: "transfer-worker" }, "archive.original.deleted", {
      deletionId: id,
      segmentId: s.id,
      versionId: s.receipt.versionId,
    });
    store.db.exec("COMMIT");
    return true;
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}
module.exports = { executeDeletion };
