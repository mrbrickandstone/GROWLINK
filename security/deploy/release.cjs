"use strict";
// Package only reviewed runtime paths from an immutable commit, never a working tree.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
function include(name) {
  return /^(security\/(server\/[^/]+\.cjs|public\/[^/]+\.(html|js|css)|deploy\/[^/]+\.(cjs|plist|example\.json|md|service|example)|(?:server|worker|watchdog|cli|backup|recovery)\.cjs|package(?:-lock)?\.json|site\.json|README\.md|environment\.example)|lib\/(ring\.cjs|security\/(coverage|ring-pilot)\.cjs)|docs\/security\/[^/]+\.(md|svg))$/.test(
    name,
  );
}
function build(output, ref = "HEAD") {
  const root = path.resolve(__dirname, "../..");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10485760,
    });
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const entries = git("ls-tree", "-r", "-z", commit)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split("\t");
      return { mode: meta.split(" ")[0], name };
    })
    .filter((e) => include(e.name));
  if (
    !entries.length ||
    entries.some((e) => !["100644", "100755"].includes(e.mode))
  )
    throw Error("INVALID_RELEASE_TREE");
  if (!path.isAbsolute(output) || fs.existsSync(output))
    throw Error("NEW_ABSOLUTE_OUTPUT_REQUIRED");
  // Reserve privately so Git cannot create a world-readable output.
  fs.closeSync(fs.openSync(output, "wx", 0o600));
  try {
    git(
      "archive",
      "--format=tar.gz",
      "--prefix=farber/",
      `--output=${output}`,
      commit,
      "--",
      ...entries.map((e) => e.name),
    );
    const sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(output))
      .digest("hex");
    const manifest = {
      commit,
      sha256,
      bytes: fs.statSync(output).size,
      files: entries.map((e) => e.name),
    };
    fs.writeFileSync(
      output + ".manifest.json",
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } catch (e) {
    fs.rmSync(output, { force: true });
    throw e;
  }
}
if (require.main === module) {
  try {
    const r = build(...process.argv.slice(2));
    console.log(
      JSON.stringify({
        commit: r.commit,
        sha256: r.sha256,
        files: r.files.length,
        bytes: r.bytes,
      }),
    );
  } catch {
    console.error("RELEASE_BUILD_FAILED");
    process.exitCode = 1;
  }
}
module.exports = { include, build };
