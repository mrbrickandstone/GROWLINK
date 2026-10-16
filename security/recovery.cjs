"use strict";
process.umask(0o077);
const { readCheckpoint } = require("./server/backup.cjs");
const { prepareRecovery } = require("./server/recovery.cjs");
(async () => {
  const [command, source, checkpoint, target, reference, extra] =
    process.argv.slice(2);
  if (
    command !== "prepare" ||
    !source ||
    !checkpoint ||
    !target ||
    !reference ||
    extra
  )
    throw Error(
      "USE_RECOVERY_PREPARE_WITH_RESTORE_CHECKPOINT_NEW_TARGET_AND_REFERENCE",
    );
  const report = await prepareRecovery(
    source,
    readCheckpoint(checkpoint),
    target,
    reference,
  );
  console.log(
    JSON.stringify({
      prepared: true,
      mode: report.mode,
      counts: report.counts,
      productionReady: false,
    }),
  );
})().catch((e) => {
  console.error(
    /^[A-Z_0-9]+$/.test(e.message) ? e.message : "RECOVERY_PREPARATION_FAILED",
  );
  process.exitCode = 1;
});
