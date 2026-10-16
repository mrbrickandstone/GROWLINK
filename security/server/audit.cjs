"use strict";
const crypto = require("node:crypto");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function auditIntegrity(db) {
  let previous = "0".repeat(64),
    count = 0;
  for (const row of db.prepare("SELECT * FROM audit ORDER BY seq").iterate()) {
    if (
      row.seq !== count + 1 ||
      row.previous !== previous ||
      row.hash !== digest(previous + "\n" + row.event)
    )
      return { valid: false, count };
    previous = row.hash;
    count++;
  }
  return {
    valid: true,
    count,
    head: previous,
    externalCheckpoint: "not-configured",
  };
}
module.exports = { digest, auditIntegrity };
