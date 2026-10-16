# Farber Security Command Center

Development handoff, October 15, 2026. This service is separate from the existing Growlink production deployment. It is **not commissioned or asserted to be OCM-compliant**.

The [Ring pilot](../docs/security/PILOT_REPORT.md) demonstrated quiet historical exports, planned-overlap coverage, token refresh and process-crash recovery on camera 1. Eight files (270,672,986 bytes) are preserved privately. A 33 ms discrepancy remains at the earliest requested boundary. This is a sample-level pass, not qualification of an unattended 60/90-day archive. Camera-native authentication, capture-clock validation, vendor policy and long-duration reliability remain unresolved.

## What is implemented

- Cameras grouped by location and room. Owner mapping: 1 and 3 → FLOWERING; 2 → FRONT DOOR. Only camera 1 has verified pilot media. Models and continuous recording on 2/3 remain unverified.
- UTC date/time search, New York display times, exact verified coverage and visibly marked unknown intervals. Historical images and separate 720p playback copies. Existing Growlink live viewing remains accessible through its existing dashboard link; this app does not start live view.
- Separate capture, archive, retention and access observations. An online flag or permission alone cannot establish recording or successful access. Local copies never show as independently archived.
- SQLite WAL/FULL durable transfer/export jobs, stable identities, renewable leases, retries, expired-lease recovery, startup reconciliation, hash/readback verification and separately stored derivatives. Media probing runs off the main event loop so heartbeats continue. A completed original is reused after derivative failure rather than requesting a new vendor export.
- Private local storage for review and a version-pinned Amazon S3 adapter with conditional uploads, full readback, optional fixed compliance retention and legal holds. S3 behavior is contract-tested with fixtures; no bucket has been provisioned or live upload performed.
- Named OIDC identities, PKCE/state/nonce, server-side sessions, CSRF/origin checks, owner MFA and five roles. Camera/time scope is checked on every request and during streams. Inspector access is named, request-specific, expiring and revocable, and Ring inspector access is policy-gated.
- Durable evidence requests with original readback and signed Ed25519 handling manifests. The package is manifest JSON plus individually authenticated original MP4 downloads. It is not a camera-native signature, vendor verifier or OCM-approved evidence format. Distribute the signing-key fingerprint through a separate trusted channel.
- Pending/active investigation holds block deletion and apply to late arrivals. Controlled deletion requires retention expiry, protected independent storage, two distinct named owners and an execution-time hold check. Shared archive objects fail closed pending group review. Physical deletion defaults off.
- Hash-chained audit history, inspection records and measured backup-power records. A reported eight-hour test requires an elapsed test interval and continuity assertion; it is not inferred from equipment labels.
- A separate watchdog process: 30-second checking, 90-second heartbeat timeout, durable incidents and dispatch retries. Provider acceptance and recipient receipt are separate. Five-minute delivery has **not** been demonstrated.

## Run a private local review

From the repository root, with Node.js 22.13+ and `ffmpeg`/`ffprobe` installed:

```sh
npm ci --prefix security --ignore-scripts
node security/cli.cjs import-pilot
node security/worker.cjs --once
node security/server.cjs --review
```

Open `http://127.0.0.1:4318`. Import requires the private `.pilot/media-*/report.json` and original files already on the owner's Mac; they are deliberately absent from Git. Import is idempotent. Review binds to loopback, requires the exact Host, denies cross-site requests and all writes, and exposes no original evidence download. Do not forward its port publicly. Stop the review with Ctrl-C when finished.

Run `npm test` at the repository root after installing security dependencies. New HTTP tests use ephemeral loopback ports and disposable synthetic data. Runtime state, signing keys, images and footage remain in ignored `.security/`; do not commit or static-host it.

## Recommended storage and worker setup

**Current owner-selected staging direction:** evaluate the existing Southampton `MARCOS-MAC-MINI`, with Backblaze B2 as the candidate off-site archive and a separate external watchdog. Follow the [Mac mini staging handoff](deploy/MAC_MINI.md) for the prepared launchd templates, read-only host check, private configuration loader, release package and cost estimate. Target hardware/access and B2 compatibility remain unverified. The AWS/Linux option below remains an alternative, not a provisioning decision.

Use one dedicated Linux host for the durable worker and control API, with the dashboard and worker running as separately supervised services. Start evaluation with 4 vCPU, 8 GB RAM and 200 GB encrypted persistent disk; measure actual day/night throughput and recovery backlog before sizing production. The current SQLite database must reside on the same local persistent filesystem for both services. Do not place it on Vercel's ephemeral filesystem or a network share. Multi-host scaling requires a transactional database migration and further testing.

Use a private, versioned **Amazon S3 Standard** bucket for independent originals, public access blocked and encryption enabled. The adapter requests server-side AES256 encryption and uses the AWS SDK credential chain, so an instance IAM role can avoid long-lived access keys. Grant only required object read/write/version/checksum/retention/hold operations; keep version deletion disabled until commissioned. Protect metadata, the audit head and signing key with independent encrypted backups and restore tests. These backups are not yet configured. [AWS credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

Once legal/vendor review approves the source policy, the implementation retains locked originals until at least the later of ingestion + 90 days and capture end + 60 days. Investigation holds can extend preservation. S3 Object Lock requires versioning and protects particular versions; fixed compliance retention cannot be shortened. Keep `SECURITY_STORAGE_LOCK_APPROVED=false` for Ring until its deletion/consent obligations are resolved. Do not use lifecycle expiration that bypasses application hold decisions. [AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)

The short camera-1 sample averages approximately 1.5 Mbit/s. Three cameras at that same rate would produce roughly 4.4 decimal TB over 90 days, before derivatives, redundancy, overhead and holds. This is an illustration, not a measured three-camera requirement or purchase quantity.

Run the watchdog on a **different host/failure domain**, with a private HTTPS heartbeat endpoint, a notification provider and named recipients. Add an external deadman monitor for watchdog silence. Configure an escalation path and record recipient receipt during commissioning. A worker heartbeat does not prove camera capture: the Ring export readiness delay cannot establish a five-minute capture-failure guarantee. A supported capture-health signal or qualified local recorder remains necessary to settle that gate.

The [systemd templates](deploy/) provide separate worker, web and watchdog units. They have not been installed. The web service expects TLS termination at the configured origin and OIDC; keep it private until commissioned. Existing Vercel production aliases and environment scopes remain unchanged. No billable resources or subscriptions were created by this implementation.

## Access and configuration needed

1. Access to the Southampton Mac mini (or an alternate dedicated worker host) and independent watchdog host; administrator access to install Node, FFmpeg, TLS and the service units; persistent encrypted volumes and a tested backup destination.
2. A private archive account/bucket and scoped credentials that pass the same version/checksum/hold tests. B2 is the current candidate; no account or bucket has been provisioned. AWS with an instance role remains an alternative.
3. An OIDC issuer, client ID/secret and registered HTTPS callback `/auth/callback`. Owner identities must receive an `amr` claim containing `mfa`. Provision each exact `issuer|subject`, name, role and camera scope with `node security/cli.cjs add-user /private/path/user.json`; no automatic role is granted at sign-in. Use two separate owner accounts for deletion approval. Live identity-provider login is still untested.
4. A dedicated approved Ring worker connection and encrypted token store. The adapter reuses the existing official client, refresh behavior and Redis locking. Do not copy production tokens or re-scope Vercel secrets by following this runbook. The prior temporary preview authorization was limited to the completed pilot and its access was retired.
5. Written source-policy decisions for automated exports, immutable retention/deletion and inspector access. A private `configure-ring` JSON file supplies `policy` flags with a `decisionReference`, and camera `id`, official `providerId`, `enabledAt` (UTC milliseconds) and `exportEnabled`. All flags default false. Configure only cameras whose actual 24/7 configuration has been verified.
6. An approved HTTPS notification webhook, credentials and recipient/escalation configuration. No messages have been sent by this implementation. End-to-end receipt within five minutes must be measured for worker, storage, network, camera, power, identity and dashboard failures.

Use [environment.example](environment.example) as a key-only template; inject real secrets from restricted service environment files or the host's secret manager. Never log them or place them in browser code. Templates assume `/opt/farber` for the checkout and `/var/lib/farber` for service data.

## Source and regulatory gates

Retain Ring as the preferred reuse candidate because the official historical endpoint returned quiet continuous samples. Do **not** qualify it as the sole required evidence source yet. Review [current OCM §125.3](https://cannabis.ny.gov/adopted-au-regulations), the [Ring program requirements](https://developer.amazon.com/docs/ring/program-requirements.html) and [content policy](https://developer.amazon.com/docs/ring/content-policy.html) with the responsible site/vendor reviewers. The existing [brief reconciliation](../docs/security/BRIEF_RECONCILIATION.md) distinguishes owner requirements, document proposals, demonstrated facts and open policy questions.

The outstanding decisions concern applicable license/security-plan requirements; synchronized embedded capture time and native evidence authentication; monitored service use and operational risk restrictions; mandatory retention/holds versus vendor deletion obligations; and OCM inspector access versus Ring's state-agency/public-safety access rules. Technical access is not permission, and a handling signature does not resolve evidence acceptance. Sources were re-opened October 15, 2026; no vendor determination has been obtained or sent.

If those gates cannot be met, retain Ring as supplemental viewing and evaluate the commercial recorder described in [ARCHITECTURE.md](../docs/security/ARCHITECTURE.md). The common six-operation interface is present; it returns explicit unverified results without a supported vendor driver. Obtain a demo/loan recorder, documented historical-search/native-export SDK, named read/export account, signed native samples and offline verifier, time-sync/storage health, a site coverage plan and measured full security-system power load. Ring compatibility with that recorder is not assumed. Nothing has been purchased.

## Remaining commissioning limitations

- Only a short one-camera pilot exists, not a seven-day day/night test or 60/90-day retained history. Cameras 2/3 still need recording qualification.
- The new app has recorded views; existing live viewing is linked through Growlink and is not embedded here. Arbitrary multi-clip automatic playback is not implemented; clips are selected from the verified timeline.
- Startup reconciliation reads preserved originals. Large-volume scheduling, backlog/source-expiry alarms and sustained-load capacity still need commissioning; do not enable unattended production exports before this work.
- Source-native investigation holds are unverified. A released application hold does not automatically clear S3 legal holds: provider release remains a separately reviewed operation. This conservatively prevents deletion until cleared. Deletion removes managed archive/staging/derivative copies, not upstream Ring recordings or prior external evidence copies.
- Audit chaining detects edits to recorded entries; an independent checkpoint and backup are required to detect truncation or whole-database replacement. Those are not yet configured.
- Live S3, OIDC, notification delivery, full disk/host loss, UPS/generator recovery and accepted inspector evidence formats have not been tested. The local app and fixture tests do not substitute for those results.
