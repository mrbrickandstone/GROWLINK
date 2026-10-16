# Monitor setup

Status checked October 16, 2026: production collection is enabled in learning mode. Its latest verified GitHub run at 12:16 UTC saved baseline capture 31, with 31 complete captures and a longest gap of 33,947,489 ms. The nominal five-minute GitHub schedule is not meeting the intended cadence. This change replaces it with a native Vercel five-minute cron; activation requires a plan supporting subdaily cron (Pro or Enterprise). Do not merge or deploy this configuration on Hobby. The recipient is supplied privately through `ALERT_TO`; no personal email is stored in source.

## First observation week

The initial mode is `MONITOR_MODE=learn`. In this mode, only Growlink, Redis, and cron authentication are required; Resend and email variables can be added later. No alerts or recommendations are sent and no controller settings are changed. `MONITOR_ENABLED=true` is still required to start capture.

The baseline clock starts only after the first capture with all configured sensors fresh. The window lasts seven elapsed days, then its baseline records freeze; rolling monitoring continues. One baseline record per five-minute time bucket avoids duplicate invocations inflating the sample count. Captures and complete captures are counted separately, with the longest observed gap recorded. Seven elapsed days do not establish complete coverage; inspect record timestamps, missing sensor data, and trailing gaps before making recommendations. Baseline records expire 30 days after their last append, allowing time for review.

Remain in learning mode until that review. Set `MONITOR_MODE=alerts` only when email delivery and desired limits are configured. No automatic switch to advice or equipment control occurs at the end of the window.

## Activation requirements

1. For alerts mode, configure a Resend account and verify a sending domain/address. Set `RESEND_API_KEY` and `ALERT_FROM` in Vercel. Set `ALERT_TO` to the requested recipient. The provider accepts the email; inbox delivery still requires a real delivery test. Skip this step for the initial observation-only week.
2. Connect an Upstash Redis database for persistent incident state and recent samples. The monitor accepts either `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or Vercel's integration-provided `KV_REST_API_URL`/`KV_REST_API_TOKEN`. Use the writable REST token, not the read-only token. Keep the Redis database dedicated to this room's monitor and avoid automatic eviction of its state keys.
3. Set a randomly generated `CRON_SECRET` and retain the existing `GROWLINK_API_KEY`. Set credentials as sensitive production environment variables. Configure preview environments with monitoring disabled.
4. Confirm the Vercel plan/scheduler. The desired cadence is every five minutes. Vercel Hobby only permits once-daily cron, which does not support this monitor's intended cadence. This branch already configures the native cron in `vercel.json`. Deploy it only after confirming plan support. Otherwise use an approved external scheduler that sends `Authorization: Bearer <CRON_SECRET>` to `/api/monitor` every five minutes. No paid upgrade or external schedule has been created.
5. Configure `MONITOR_RANGES_JSON` only after confirming crop targets and units. With `{}`, the monitor checks freshness and upstream availability only. Per-sensor bounds must contain both numeric `min` and `max`; sensor IDs must be in `config.cjs`. Limits are constant across lighting phases in this version. Sensor units match the existing dashboard's Growlink request headers; verify VWC/EC calibration before setting limits.
6. After the implementation and recipient are reviewed, retain `MONITOR_ENABLED=true` and deploy on the supported plan. Verify an authenticated run, stored samples, alert persistence, real inbox delivery, and a recovery notice before treating the monitor as operational. Deployment protection must permit authorized scheduled requests without exposing the endpoint; its bearer authentication remains required.

## Native five-minute scheduling and release

`vercel.json` now declares `*/5 * * * *` for `/api/monitor`. Vercel supplies the existing `CRON_SECRET` as a Bearer authorization header. Keep deployment protection and the endpoint's authentication enabled. No new credentials, recipients, model or equipment controls are introduced. The existing learning state and baseline remain intact.

Before merging, the owner must upgrade this existing team from Hobby to a plan supporting five-minute cron, or choose an external scheduler with authenticated requests instead. This change does not purchase an upgrade. A deployment with this cron is expected to be rejected on Hobby.

After the plan is ready, merge and deploy to production. Confirm that the production deployment includes the cron, and inspect at least three successive `growlink_capture` log events approximately five minutes apart. Require fresh sensor data and advancing baseline counts while the baseline window is open. After the seven-day window, baseline counts intentionally freeze; current captures continue in the rolling list. Do not confuse that expected freeze with a failed scheduler. Inspect recorded gaps before relying on the baseline.

The GitHub workflow remains available for manual verification and emergency capture, but its unreliable scheduled trigger is removed in the same release. It calls only the authenticated production monitor and logs counts, not raw telemetry. A manual run must not be reported as evidence that the new scheduler works.

Current production stays unchanged until the plan requirement is met and this release is deployed. No historic gap is repaired by changing the scheduler, and the elapsed observation week is not evidence of complete coverage.

## Sensor and alert behavior

The monitor reads only the configured sensors. It never writes to Growlink controls. Missing values, nonnumeric values, missing timestamps, readings older than five minutes, or timestamps over a minute in the future count as a freshness problem. Zone-less timestamps use UTC, matching the dashboard. The same incident must persist across observations separated by at least five minutes before an alert; recovery must also persist. At five-minute cadence, notification may take roughly five to ten minutes after an issue first becomes observable, in addition to freshness age.

Emails are sent once on confirmed onset and once on confirmed recovery. There are no repeating reminders. New incident codes can generate further emails. Delivery state is saved before sending; retries reuse the exact message and Resend idempotency key. Automatic retries stop after 23 hours because Resend retains idempotency keys for 24 hours. Reconcile an overdue pending delivery against Resend logs before repairing its stored state; do not blindly resend. Redis/email failures return HTTP 503 and require separate scheduler/platform failure monitoring.

Recent snapshots are capped at 2,016 entries, approximately seven days at five-minute cadence. Snapshot phase labels use the scheduled 11 p.m.–11 a.m. New York lighting window, not observed equipment state. Data is suitable for later irrigation analysis; this version does not infer applied volume, runoff, or change irrigation settings.

## Tests and limits

`npm test` runs mocked unit/integration checks for auth, freshness, allowlisted limits, incident confirmation, outage handling, lock contention, and retry identity. The October 16 production workflow confirms a successful fresh-data capture through Growlink and persistent storage. Native cron cadence has not yet been verified; Resend and inbox delivery remain unverified. Sensor baselines and irrigation alert limits still need confirmation. No cameras or AI model are connected in this first monitoring layer.

References: [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Upstash REST API](https://upstash.com/docs/redis/features/restapi), [Resend email API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

