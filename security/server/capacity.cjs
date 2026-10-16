"use strict";
const fs = require("node:fs");
const { Transform } = require("node:stream");
const { error } = require("./store.cjs");
const JOB_HEADROOM = 1024 * 1024 * 1024;
class DiskGuard {
  constructor(
    root,
    { env = process.env, statfs = fs.statfsSync, paused = false } = {},
  ) {
    const configured = env.SECURITY_MIN_FREE_BYTES || "20000000000";
    if (!/^\d+$/.test(configured)) throw error("INVALID_DISK_RESERVE");
    this.minimum = Number(configured);
    if (
      !Number.isSafeInteger(this.minimum) ||
      this.minimum < 1e9 ||
      this.minimum > 1e15
    )
      throw error("INVALID_DISK_RESERVE");
    this.resume = Math.ceil(this.minimum * 1.25);
    this.warning = this.minimum * 2;
    this.root = root;
    this.statfs = statfs;
    this.paused = paused;
  }
  inspect(requiredBytes = 0) {
    let freeBytes = null;
    try {
      const s = this.statfs(this.root);
      const bytes = s.bavail * s.bsize;
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        !Number.isSafeInteger(s.bsize) ||
        s.bsize <= 0
      )
        throw Error();
      freeBytes = bytes;
    } catch {}
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0)
      throw error("INVALID_SPACE_REQUEST");
    if (freeBytes === null || freeBytes < this.minimum + requiredBytes)
      this.paused = true;
    else if (freeBytes >= this.resume + requiredBytes) this.paused = false;
    const state =
      freeBytes === null
        ? "unknown"
        : this.paused
          ? "paused"
          : freeBytes < this.warning
            ? "warning"
            : "ready";
    return {
      state,
      paused: this.paused,
      freeBytes,
      reserveBytes: this.minimum,
      resumeBytes: this.resume,
      warningBytes: this.warning,
      code:
        state === "unknown"
          ? "DISK_CAPACITY_UNKNOWN"
          : state === "paused"
            ? "DISK_SPACE_LOW"
            : state === "warning"
              ? "DISK_SPACE_WARNING"
              : null,
    };
  }
  assertSpace(bytes = 0) {
    const result = this.inspect(bytes);
    if (result.paused) throw error(result.code, 503);
    return result;
  }
  writer() {
    return new Transform({
      transform: (chunk, encoding, done) => {
        try {
          this.assertSpace(chunk.length);
          done(null, chunk);
        } catch (e) {
          done(e);
        }
      },
    });
  }
}
function capacityError(e) {
  return (
    ["DISK_CAPACITY_UNKNOWN", "DISK_SPACE_LOW"].includes(e?.message) ||
    e?.code === "ENOSPC"
  );
}
module.exports = { DiskGuard, JOB_HEADROOM, capacityError };
