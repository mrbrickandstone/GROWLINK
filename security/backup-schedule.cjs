"use strict";
process.umask(0o077);
const { readConfig, run, reconcile } = require("./server/backup-scheduler.cjs");
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => controller.abort());
(async () => {
  const [command, file, confirmation, reference, extra] = process.argv.slice(2);
  if (!file || extra) throw Error("BACKUP_SCHEDULE_ARGUMENTS_REQUIRED");
  const config = readConfig(file);
  let result;
  if (command === "run" && !confirmation && !reference)
    result = await run(config, { signal: controller.signal });
  else if (
    command === "reconcile" &&
    confirmation === "--processes-confirmed-stopped"
  )
    result = reconcile(config, { processesStopped: true, reference });
  else throw Error("BACKUP_SCHEDULE_ARGUMENTS_REQUIRED");
  console.log(JSON.stringify(result));
  if (["failed", "locked"].includes(result.state)) process.exitCode = 1;
})().catch((e) => {
  console.error(
    /^[A-Z_0-9]+$/.test(e.message) ? e.message : "BACKUP_SCHEDULE_FAILED",
  );
  process.exitCode = 1;
});
