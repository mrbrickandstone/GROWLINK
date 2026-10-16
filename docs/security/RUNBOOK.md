# One-camera Ring pilot runbook

The October 13 pilot is complete and its temporary runtimes have been retired. Historical URLs in the findings are no longer active. Originals, private receipts and resumable ledgers remain in the ignored `.pilot/` directory; sanitized results are in `pilot/results/`. See `2026-10-13-pilot-final.json` and `2026-10-13-pilot-cleanup.json`. The instructions below describe a new explicitly authorized, bounded test, not an active archive service.

Run from the isolated `growlink/` checkout. This uses the existing Ring account's credentials and distributed lock; use one pilot worker. It may rotate OAuth tokens in the existing encrypted token store, as required by the test. It does not change recording settings or initiate live view.

## Access and preparation

1. Restore the existing Vercel CLI login (`vercel login`) on the authorized Mac. Check the `.vercel/project.json` target: `farber-growlink-dashboard`, project `prj_iJf92GdUs9LfzFhq6raHprCU6G1B`, team `team_jAJWNnxg9NdbPls1w9MD7Z7Q`. Do not deploy.
2. Securely provide `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_HMAC_KEY` and the existing Upstash/KV REST URL and writable REST token. A gitignored `.env.pilot.local` is supported; use mode 0600. Prefer the service's secret injection. Never pass values in shell arguments or commit them. Do not clone refresh tokens to a competing uncoordinated store.
3. Use Node >=22.13 with `node:sqlite`, FFmpeg and ffprobe. Run `npm run pilot -- preflight`. SQLite runs locally; this is not a Vercel function or production archive database.
4. Run `npm run pilot -- inventory`. Inspect `.pilot/inventory.private.json` locally. The command prints only a count and file path. Check current permission scope where available; legacy tokens may lack stored scope. Successful inventory access does not establish historical download permission.
5. Obtain camera/account configuration evidence from the Ring owner: exact model, continuous power, required subscription, 24/7 enabled, mode schedule, consent start, location, room, and camera module if applicable. Do not enable live view while selecting the test window. Owner-attested evidence is explicitly separate from API observations. Model eligibility and subscription are not inferred from online status.

## Historical test

### Protected Vercel secrets: current pilot access

The existing production Ring/Redis variables are `sensitive`. `vercel env pull` creates empty values for them; a successful pull does not provision the local worker. Do not weaken those secrets or expose them through a debug endpoint.

The reviewed temporary metadata bridge was prepared with `node scripts/prepare-pilot-bridge.cjs`. Its generated `.pilot/bridge/staging` contains only the metadata handler, Ring client and public verification key; the private signing key remains outside the upload directory. It is a four-hour runtime, not an archive service. The actual staged deployment and expiry are recorded in the pilot report. The existing main dashboard API does not expose these operations.

While the runtime is active, `node scripts/cloud-pilot.cjs inventory`, `node scripts/cloud-pilot.cjs refresh`, and `node scripts/cloud-history.cjs` make signed requests using authenticated `vercel curl`. The last command selects camera “1” by the saved initial inventory input and only identifies candidate quiet periods. Raw inventory/history stay private. Do not infer the hardware model from the image asset URL: Ring explicitly says it is not an API contract.

**Observed deployment caveat:** `vercel deploy --prod --skip-domain` left the primary URL unchanged but reassigned the secondary team alias. It was restored immediately. Check and record all aliases before and after any future staging, and restore unintended changes to their prior deployment. Do not promote this metadata-only runtime. Production code, recording settings and the current dashboard must remain intact.

The currently deployed bridge refuses media downloads. The new optional transport is implemented locally: `PILOT_BRIDGE_DIR` selects an isolated bridge directory, and `prepare-pilot-bridge.cjs <private-authorization.json>` binds its media authority to one camera, an enablement lower bound, an end bound and a maximum request duration. Requests ending less than five minutes ago are refused. It cannot start live view. Its streaming response retains the vendor status and media timing; the local worker stores separate private HTTP receipts and durable originals. Never mistake a prepared staging directory for a deployed media runtime.

On October 13, automatic approval review initially rejected temporary branch access to the three production Ring secrets. The owner subsequently explicitly approved it. Vercel requires preview-only variables for a specific branch and requires that branch to exist remotely. The connected GitHub app created `codex/farber-security-pilot` from the original main commit after native Git push returned HTTP 403. During the approved build only, the three variables were scoped to that preview branch, then restored to production-only. Existing deployments retain their injected environment; all three production aliases were checked against the original deployment after the build. No credentials were copied to local files or the source bundle.

The first preview lacked Git metadata and did not receive the scoped Ring secrets. Its HTTP 503 occurred before a Ring media request. The corrected deployment uses Vercel's official deployment API with explicit `gitMetadata.commitRef` and the preview default (omit `target`; the API rejects the literal `preview`). Its immutable URL and restored scopes are recorded in `pilot/results/2026-10-13-media-preview-corrected.json`. Always verify the branch in the deployment result and perform a metadata operation before interpreting media-test results.

After an approved deployment, these commands use the same durable queue and media verification as the independent runner:

```sh
PILOT_BRIDGE_DIR=.pilot/media-bridge PILOT_DIR=.pilot/media-smoke node scripts/ring-pilot.cjs run .pilot/media-smoke-plan.json --one-job
PILOT_BRIDGE_DIR=.pilot/media-bridge PILOT_DIR=.pilot/media-smoke node scripts/ring-pilot.cjs run .pilot/media-smoke-plan.json
```

### Independent worker

Updated owner observation: the plan was upgraded and camera “1” was switched to 24/7 “JUST NOW.” The conservative earliest test timestamp is 2026-10-13 18:08 UTC. Preserve the earlier motion-only observation as historical evidence, but do not treat it as the current setting. No agent purchase or mode change was made. Choose windows after both enablement and app consent.

Copy `pilot/plan.example.json` to `.pilot/plan.json`, replace camera/window values, and complete the evidence fields only after checking them. Start with adjacent five-minute requests as a smoke test, then several consecutive quiet hours as the briefs require. Repeat separate day/night windows over a seven-day engineering pilot, using a new PILOT_DIR for each plan. Set an explicit optional `lookbackSeconds` (0–10) before execution to request overlap; segment plus lookback must stay within both API and pilot-runtime limits. For a five-minute runtime cap, `segmentSeconds: 299` plus `lookbackSeconds: 1` yields 300-second requests. History and consent checks include the margin. Retries never change stored timestamps. Target coverage is evaluated independently of individual shifted responses. Example times are illustrative, not confirmed continuous recording. Long-term retention checks through days 61 and 91 are separate from a seven-day pilot.

```sh
npm run pilot -- run .pilot/plan.json --one-job
npm run pilot -- run .pilot/plan.json
npm run pilot -- report
```

The first process exits after one job. The second process opens the persisted queue. To test a crash, terminate the worker during a transfer and restart the same plan after its ten-minute lease expires. Do not delete its database. Preserve both process run IDs and compare pre/post-crash original hashes and queue states. Concurrent workers cannot finalize another worker's leased job. Interrupted `.part` files are not evidence; preserve them for diagnosis until the run is closed.

Retryable jobs retain their next eligible time; rerun the command after that time. This is a bounded pilot CLI, not an installed unattended scheduler. Terminal failures stay visible. A different test window needs a fresh PILOT_DIR so results cannot be mixed. Reconciliation checks already completed files before resuming or reporting.

```sh
npm run pilot -- refresh
npm run pilot -- inventory
```

The refresh command performs the official refresh exchange and verifies a fresh client's use of persisted credentials. The separate inventory invocation tests process-level credential recovery. Record both as observed evidence; the unit tests are not substitutes. Do not force expiry by corrupting production credentials or revoking the account.

## Assessment

Review `.pilot/report.json` and the preserved `.pilot/originals/` files. Never publish these files to the website or GitHub.

For each request, compare requested start/end to X-Media-Timestamp, X-Media-Length where supplied, ffprobe duration, frame timing, decode results, byte count and hashes. Inspect both sides of every adjacent boundary for jumps, repeats, frozen frames or a changed scene inconsistent with timestamps. Check embedded clock and timezone against a trusted site reference, legibility at required identification points, lighting and color-still export. Do not transcode, stamp or trim the preserved downloads. Any playback derivative belongs in separate storage.

The API may redirect to presigned media. The client drops credentials, enforces HTTPS and restricts destinations to approved AWS media domain families. Unexpected hosts stop for review; no signed URL is printed. A partial or shifted response exposes gaps, and a response without an actual start timestamp cannot establish coverage. The runner deliberately blocks unsupported schema/host cases instead of guessing.

Write a signed-off human assessment with actual observations and source links. Keep three conclusions separate: technical sample continuity, operational reliability, and legal/vendor suitability. Passing one sample is not proof of 60/90 days of retention, every camera, an eight-hour outage, or five-minute notification delivery.

## Production boundary

No Ring-to-archive source is enabled. No hardware was commissioned. No monitoring emails/SMS were sent. This branch defines interfaces for a local recorder and independent archive but has no storage vendor credentials, immutable bucket, native recorder adapter, named-user login, dashboard playback, hold/deletion service or inspector portal. Both briefs are now reviewed. Those implementations follow the validated source decision, policy clearance and provisioning.
