# Independent monitoring handoff

Development implementation, October 15, 2026. No external monitor, recipient or paid service has been configured. This document defines the prepared interfaces and commissioning work; it does not establish five-minute notification delivery or OCM compliance.

## Three separate services

The Southampton worker captures/archives through its approved recording source and reports allowlisted faults to the external watchdog. The watchdog lives outside Southampton's power/network failure domain, accepts worker heartbeats, independently probes the control web service and dispatches incidents through the configured notification webhook. A secondary monitor, on a separately operated service/failure domain, watches pulses from the watchdog itself. It must use an independent notification path so failure of the primary webhook does not silence both paths.

Stopping the dashboard never stops the worker by design. A local synthetic test actually stopped the dashboard endpoint and ran a separate worker, which preserved and verified an original and built its playback copy. This proves process separation in that fixture; Ring capture, actual Mini operation, network/power independence and off-site storage still require site tests.

## Private dashboard readiness

Set `SECURITY_HEALTH_TOKEN` in the web service's private config. Set the matching `SECURITY_CONTROL_HEALTH_TOKEN` and `SECURITY_CONTROL_HEALTH_URL=https://YOUR_PRIVATE_ORIGIN/healthz/ready` on the watchdog. Use a dedicated random credential of at least 32 characters, distinct from the worker heartbeat and secondary-monitor credentials. Keep it out of chat, command history, Git and proxy/access logs. Both probe settings must be supplied together; an empty pair disables this probe explicitly.

The probe sends a fresh random nonce over HTTPS with bearer authentication. The server returns a signed, nonce-bound response that reports whether it can read its control database and whether named sign-in is configured. The watchdog requires the expected service/protocol, exact nonce, signature and a timestamp within 60 seconds of its clock. Redirects, login HTML, oversized bodies, old replies, wrong signatures, database read errors and missing sign-in configuration fail. Responses are limited to 4 KiB and each network operation has a ten-second timeout. The health credential cannot sign in, read cameras, export footage or change records. The endpoint is absent when no health credential is configured; read-only review does not pass named-sign-in readiness.

The public `/healthz` remains a basic process-liveness response; it is not used as proof of readiness. The signed probe does not prove database writes, a successful live identity-provider login, browser asset loading, camera capture, archive bytes, object-lock state, clock authenticity or end-user playback. Its clock tolerance is a stale-response check, not site capture-clock certification.

The watchdog automatically adds the reserved `control-web` component when this probe is configured. Do not put it in `SECURITY_EXPECTED_COMPONENTS`; that list is for heartbeat senders. The HTTP heartbeat endpoint rejects attempts to impersonate `control-web` or send its reserved fault codes. At most eight total unique components are accepted to bound the notification work per cycle.

## Secondary monitor pulse

Configure `SECURITY_DEADMAN_URL` and `SECURITY_DEADMAN_TOKEN` privately on the watchdog. Both are required together. The URL must use HTTPS without userinfo or fragment; redirects are rejected. The provider or an approved relay must accept an authenticated JSON POST and return 2xx. No specific vendor is integrated or assumed compatible yet. The key-only [watchdog config example](watchdog.example.json) is accepted by the existing private service loader; the Linux unit also supports a restricted environment file.

The pulse contains only service identity, completion time, durable sequence and an idempotency key. It contains no camera names, footage, incident details or credentials. Its credential is separate from primary heartbeat and dashboard health credentials. A successful response records endpoint acceptance, not notification delivery.

The watchdog checks immediately after startup and on a 30-second timer. Cycles do not overlap. A pulse is sent only after the probe/incident cycle completes, a notification dispatcher is configured and every open incident has been accepted by that dispatcher. A failed or unconfigured primary notification path withholds pulses; a stopped process, hung cycle or unavailable watchdog host also stops them. A monitored dashboard outage can still produce a pulse once its incident was accepted: that pulse means the watchdog is functioning, not that the dashboard is healthy. Pulse transport failures remain explicit in private status, and the secondary service must detect the missing pulses independently.

Configure the secondary service to detect **no pulse for at most 180 seconds** and dispatch promptly through its separate path. Test its scheduling, retry and recipient latency so the complete failure-to-receipt interval stays within five minutes. The normal cycle is 30 seconds, but multiple bounded notification attempts can lengthen a cycle. These proposed timing settings have not been commissioned with a provider. Provider acceptance alone cannot close the delivery gate.

Authenticated `GET /status` exposes the last completed cycle, sequence, probe configuration, pulse state, incidents and a 90-second cycle-freshness observation. It always reports `deliveryCommissioned: false`; this release has no trusted provider receipt callback to automatically establish recipient delivery. Record measured delivery evidence through the commissioning process. Status does not expose configured endpoint URLs or secret values.

## Required failure tests before activation

| Injected failure | Expected observation | Evidence still needed on the real setup |
|---|---|---|
| Web service/TLS/front-door outage | Independent `control-web` incident; worker continues | Original hashes/timestamps during outage and actual recipient receipt |
| Control database read failure | Signed failed readiness response | Target-disk failure behavior and recovery |
| Wrong/revoked health token or stale response | Failed probe, never healthy | Reverse-proxy/cache behavior and clock settings |
| Worker silence | Existing 90-second heartbeat timeout | Host/network loss and actual receipt |
| Primary notification endpoint failure | Retry with same incident key; secondary pulse withheld | Independent secondary alert received within five minutes |
| Watchdog crash/host/network loss | Pulses cease; secondary monitor detects silence | Third-party detection, recipient receipt and restart history |
| Secondary endpoint failure | Failed pulse state; remote service sees silence | Provider outage/escalation plan and independent recipients |
| Identity-provider outage, camera/recorder failure, power loss | Separate supported signal or controlled commissioning observation | These are not established by configuration or a worker heartbeat |
| Archive corruption or retention failure | Existing full-byte checks/retention controls; additional provider-health monitoring | Seven-day readback is not five-minute corruption detection |

Use disposable test footage and explicitly authorized test notifications during commissioning. Preserve incident IDs, failure/start times, dispatch acceptance, recipient receipt, recovery time and relevant hashes as evidence. Tests should cover both named and unconfigured components, startup, SIGKILL, restart, lost credentials and exhausted notification retries. Do not mark the system commissioned while any required fault path lacks measured results.

## Local verification

Ten added automated tests cover private signed readiness, wrong/absent credentials, replay/stale/tampered responses, database failures, sign-in configuration, bounded/malformed responses, endpoint/credential separation, nonoverlapping cycles, notification-failure pulse suppression, retry identity after reopen, reserved-component spoof rejection and status freshness. A real watchdog subprocess used disposable local TLS endpoints, survived an actual SIGKILL/restart with a preserved cycle sequence and sent a synthetic incident when the dashboard fixture failed. A separate actual worker completed synthetic archive/playback work after the dashboard endpoint was stopped. No real recipient, external provider, Ring API or production service was contacted.
