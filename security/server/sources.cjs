"use strict";
// A recorder vendor driver must implement the same six operations and return explicit
// unsupported/unverified results. Never synthesize continuous intervals from events.
const operations = [
  "discoverCameras",
  "getRecordingStatus",
  "listRecordedIntervals",
  "exportOriginal",
  "createViewerSession",
  "exportEvidence",
];
class CommercialRecorderSource {
  constructor(driver) {
    this.driver = driver;
  }
}
for (const op of operations)
  CommercialRecorderSource.prototype[op] = async function (input) {
    if (typeof this.driver?.[op] !== "function")
      return {
        kind: "unverified",
        reason:
          "Supported recorder API/SDK, named read/export account, native sample and verifier required",
      };
    return this.driver[op](input);
  };
module.exports = { CommercialRecorderSource, operations };
