"use strict";
process.umask(0o077);
const path = require("node:path");
const { Store } = require("./server/store.cjs");
const { archiveFor } = require("./server/archive.cjs");
const { createServer } = require("./server/http.cjs");
const review = process.argv.includes("--review"),
  port = Number(process.env.SECURITY_PORT || 4318),
  host = review ? "127.0.0.1" : process.env.SECURITY_HOST || "127.0.0.1";
const origin = process.env.SECURITY_ORIGIN || `http://127.0.0.1:${port}`;
if (!review && !process.env.SECURITY_OIDC_ISSUER) {
  console.error(
    "NAMED_SIGN_IN_NOT_CONFIGURED. Use --review only for a read-only loopback preview.",
  );
  process.exit(1);
}
if (!review && new URL(origin).protocol !== "https:") {
  console.error("HTTPS_ORIGIN_REQUIRED");
  process.exit(1);
}
const store = new Store(
  process.env.SECURITY_DATA_DIR || path.join(__dirname, "../.security"),
);
const server = createServer({
  store,
  archive: archiveFor(process.env, store.root),
  origin,
  review,
});
server.listen(port, host, () =>
  console.log(
    `Farber Security: ${origin} (${review ? "read-only local review" : "named sign-in required"})`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
