# Monitor setup

Status: implemented on the monitoring branch, not deployed or active. The recipient is supplied privately through `ALERT_TO`; no personal email is stored in source.

## Activation requirements

1. Configure a Resend account and verify a sending domain/address. Set `RESEND_API_KEY` and `ALERT_FROM` in Vercel. Set `ALERT_TO` to the requested recipient. The provider accepts the email; inbox delivery still requires a real delivery test.
2. Connect an Upstash Redis database for persistent incident state and recent samples. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Keep the Redis database dedicated to this room's monitor and avoid automatic eviction of its state keys.
3. Set a randomly generated `CRON_SECRET` and retain the existing `GROWLINK_API_KEY`. Set credentials as sensitive production environment variables. Configure preview environments with monitoring disabled.
4. Confirm the Vercel plan/scheduler. The desired cadence is every five minutes. Vercel Hobby only permits once-daily cron, which does not support this monitor's intended cadence. If the project plan supports it, replace `vercel.json` with `vercel.monitor.example.json` before production deployment. Otherwise use an approved external scheduler that sends `Authorization: Bearer <CRON_SECRET>` to `/api/monitor` every five minutes. No paid upgrade or external schedule has been created.
5. Configure `MONITOR_RANGES_JSON` only after confirming crop targets and units. With `{}`, the monitor checks freshness and upstream availability only. Per-sensor bounds must contain both numeric `min` and `max`; sensor IDs must be in `config.cjs`. Limits are constant across lighting phases in this version. Sensor units match the existing dashboard's Growlink request headers; verify VWC/EC calibration before setting limits.
6. After the implementation and recipient are reviewed, set `MONITOR_ENABLED=true` and deploy. Verify an authenticated run, stored samples, alert persistence, real inbox delivery, and a recovery notice before treating the monitor as operational. Deployment protection must permit authorized scheduled requests without exposing the endpoint; its bearer authentication remains required.

## Behavior

The monitor reads only the 16 configured sensors. It never writes to Growlink controls. Missing values, nonnumeric values, missing timestamps, readings older than five minutes, or timestamps over a minute in the future count as a freshness problem. Zone-less timestamps use UTC, matching the dashboard. The same incident must persist across observations separated by at least five minutes before an alert; recovery must also persist. At five-minute cadence, notification may take roughly five to ten minutes after an issue first becomes observable, in addition to freshness age.

Emails are sent once on confirmed onset and once on confirmed recovery. There are no repeating reminders. New incident codes can generate further emails. Delivery state is saved before sending; retries reuse the exact message and Resend idempotency key. Automatic retries stop after 23 hours because Resend retains idempotency keys for 24 hours. Reconcile an overdue pending delivery against Resend logs before repairing its stored state; do not blindly resend. Redis/email failures return HTTP 503 and require separate scheduler/platform failure monitoring.

Recent snapshots are capped at 2,016 entries, approximately seven days at five-minute cadence. Snapshot phase labels use the scheduled 11 p.m.–11 a.m. New York lighting window, not observed equipment state. Data is suitable for later irrigation analysis; this version does not infer applied volume, runoff, or change irrigation settings.

## Tests and limits

`npm test` runs mocked unit/integration checks for auth, freshness, allowlisted limits, incident confirmation, outage handling, lock contention, and retry identity. Real Growlink, Redis, Resend, the cron scheduler, and inbox delivery have not been tested. Sensor baselines and irrigation alert limits still need confirmation. No cameras or AI model are connected in this first monitoring layer.

References: [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Upstash REST API](https://upstash.com/docs/redis/features/restapi), [Resend email API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
