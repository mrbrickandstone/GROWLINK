# Development verification — October 15, 2026

**Result: local development flow passes; production commissioning remains blocked on external services and source-policy decisions.** This report is separate from the [October 13 Ring pilot](PILOT_REPORT.md), whose sample-level pass and full-qualification limitations remain unchanged.

Story: an authorized viewer selects a room/camera and historical window; the API returns verified intervals from a durable ledger, serves a separate playback copy, and discloses gaps. Authorized evidence requests enter a durable queue, are reauthorized and read back by the worker, then expose a signed handling manifest and individually authenticated originals.

| Boundary | Actual result |
|---|---|
| Inventory and room grouping | Browser shows 1/3 in FLOWERING and 2 in FRONT DOOR; mappings persisted and fresh-import defaults saved |
| Actual pilot preservation | Eight real originals, 270,672,986 bytes, eight completed durable jobs; startup reconciliation completed; local audit chain valid |
| Browser → API → playback | Camera 1's 60.133008-second playback derivative reached readyState 4, currentTime advanced from 0.290912 to 4.383451 seconds, paused=false and no media error |
| Timestamp coverage | UI window 18:08:00.000–18:31:59.232 UTC shows 1,439.199 / 1,439.232 seconds covered and the first 0.033 seconds unverified. Its end is the last actual returned frame boundary, distinct from the pilot report's fixed 18:31:59 target |
| Missing footage | Camera 2 returns zero covered seconds for that window; video and previous-camera caption are hidden; full unverified interval is visible |
| Read-only review | Evidence, hold, deletion and commissioning writes visibly disabled; HTTP tests independently confirm server-side denial |
| Browser health | No captured warning/error console entries during reviewed flows; screenshots saved privately under `.security/review/` |
| Full automated suite | `npm test`: **59 passed, 0 failed, 0 skipped**. Includes existing Growlink, monitoring and Ring tests |
| API authorization | Anonymous API/media denied; cross-site and CSRF writes denied; camera scope, owner MFA, inspector bounds/expiry/revocation, original-export request binding and current worker-time permissions tested |
| Storage and evidence | Local tamper/readback rejection, exact byte ranges, signed manifest verification/tamper rejection, S3 version/retention/hold/delete command contract and corrupt/unversioned response rejection tested |
| Durability | Stable job IDs, expired lease reclaim, renewal, stale completion rejection, deferred export processing and synthetic real-FFmpeg transfer/derivative recovery from preserved original tested |
| Holds/deletion | Late-arrival holds, two owners, retention floor, execution-time hold checks, deletion-intent reconciliation and shared-object protection tested |
| Monitoring | Missing heartbeat, repeated unknown health, retry after dispatch failure and provider-acceptance-versus-recipient-receipt distinction tested with fixtures |
| Site records | Inspection due dates, five-year records and elapsed measured power-test rules tested with fixtures; no actual site commissioning record was invented |

The final browser check found that an empty camera search retained the previous clip's caption. The empty-state path now hides both the player and caption; the corrected result was verified in the browser. No live view was started during these checks.

S3 tests use SDK-response fixtures, HTTP identity tests use explicit test-factory principals, and transfer tests use disposable generated media. These are not live S3/OIDC/notification or site-power tests. The only real Ring footage is the earlier pilot, copied locally without new Ring requests in this application phase. No notifications, purchases, physical evidence deletions or production promotions were performed.

## Concrete remaining gates

See [deployment/access instructions](../../security/README.md). Required: dedicated worker and independent watchdog hosts; private versioned archive and IAM role; named OIDC client/users; approved dedicated Ring worker access; written vendor/source-policy decisions; configured recipients and measured five-minute receipt; capture-time/native-evidence validation; camera 2/3 qualification; site coverage, backup-power and inspection commissioning; independent audit/metadata backups; sustained-load and source-expiry/backlog validation. Commercial-recorder drivers remain explicitly unverified pending supported vendor access.

The prototype does not establish complete 60/90-day retention or OCM compliance. Production acceptance must not be inferred from passing software tests.
