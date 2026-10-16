"use strict";
process.umask(0o077);
const {
  readConfig,
  readCheckpoint,
  createBackup,
  restore,
} = require("./server/backup.cjs");
(async () => {
  const [command, configFile, checkpointFile, target] = process.argv.slice(2);
  if (!configFile || !checkpointFile)
    throw Error("USE_BACKUP_OR_RESTORE_WITH_PRIVATE_CONFIG_AND_CHECKPOINT");
  const config = readConfig(configFile);
  if (command === "backup" && !target) {
    const result = await createBackup(config, checkpointFile);
    console.log(
      JSON.stringify({
        snapshotId: result.snapshotId,
        manifestSha256: result.manifestSha256,
        restoreVerified: true,
        independentLocationVerified: false,
        originalFootageIncluded: false,
      }),
    );
  } else if (command === "restore" && target) {
    const result = await restore(
      config,
      readCheckpoint(checkpointFile),
      target,
    );
    console.log(
      JSON.stringify({
        restored: true,
        recoveryRevalidationRequired: true,
        auditEntries: result.database.audit.count,
        signedExports: result.database.signedExports,
        originalFootageIncluded: false,
      }),
    );
  } else
    throw Error("USE_BACKUP_OR_RESTORE_WITH_PRIVATE_CONFIG_AND_CHECKPOINT");
})().catch((e) => {
  // An unexpected filesystem/provider error may contain a private path or value.
  console.error(
    /^[A-Z_0-9]+$/.test(e.message) ? e.message : "BACKUP_COMMAND_FAILED",
  );
  process.exitCode = 1;
});
