# Recording-source decision and implementation boundary

Status: design proposal reconciled with both supplied briefs; recording source remains unqualified. Interfaces exist in `lib/security/contracts.d.ts`. A separate development application and durable worker are now implemented in [`security/`](../../security/README.md); the production services below are not deployed. See `BRIEF_RECONCILIATION.md` for source precedence, differences, acceptance gates and vendor-policy questions. The owner subsequently reports upgrading the plan and enabling 24/7 on camera “1”. The one-camera quiet export, planned-overlap and restart pilot passed its tested samples; full qualification remains open. the earlier motion-only finding remains historical evidence.

## Source decision

Ring remains a candidate for reuse, with existing live viewing retained. Require measured historical continuity plus vendor confirmation before promoting it to the primary source. If unavailable or unsuitable, commission a commercial local recorder whose recording service operates without Vercel, dashboard login, internet access or the export worker.

A concrete evaluation candidate is **AXIS S1216 Tower Mk II with AXIS Camera Station Pro**, paired with **AXIS P3275-LV** for an appropriate indoor pilot location. Verify lens, environmental suitability, coverage and required outdoor variants onsite. Axis documents signed exports and camera-origin signed-video support in its VMS; validate the exact selected camera, firmware and export format with sample files. This is a candidate for a vendor demonstration, not a purchase recommendation or assertion that Ring cameras connect to it. [Recorder successor listed by Axis](https://www.axis.com/products/axis-s1216-tower/support), [camera](https://www.axis.com/products/axis-p3275-lv), [VMS evidence features](https://help.axis.com/en-us/axis-camera-station-pro-feature-guide)

For a recorder pilot, obtain a loan/demo or access to an existing recorder, a named service account with historical-search and native-export permissions, supported SDK/API documentation, native signed evidence plus its offline verifier, MP4/MKV and JPEG samples, time-sync status, recorder storage health and continuous-recording configuration. The adapter must be validated against the selected vendor before any implementation is called complete. Milestone XProtect is an alternative with a documented export SDK and native signed evidence format. [Milestone export sample](https://doc.developer.milestonesys.com/mipsdk/samples/ComponentSamples/ExportSample/README.html), [signature verification](https://doc.milestonesys.com/xprotect/xprotect-smart-client/2025r3/en/verify-digital-signatures.html)

Also needed: appropriately sized managed PoE switch, cabling, secured recorder room/rack, redundant recording disks, an independent storage destination with object lock/versioning and encryption, worker host with persistent disk, separately hosted watchdog and configured notification recipients, and UPS/generator capacity for the complete security load. Do not assume an ordinary UPS label proves eight hours.

Disk sizing must use measured aggregate bitrate. Decimal TB for 90 continuous days = aggregate Mbit/s × 0.972, before redundancy, filesystem overhead, headroom and investigation holds. As an illustration only, three cameras at 4 Mbit/s each require about 11.664 TB of video, or 14.58 TB with 25% headroom, before RAID overhead. Inventory has three cameras; sustained aggregate bitrate remains unknown; do not order storage from this illustration.

## Proposed data flow

1. Camera/recorder captures continuously according to the approved site policy. Dashboard outages cannot stop recording.
2. A durable worker enumerates actual source intervals, enqueues camera/component/time/source-version identities, and leases bounded transfers. Persist retries and checkpoints outside Vercel request lifetimes. Use independent credentials for production and preview.
3. Preserve native originals, vendor signatures and export metadata. Hash while downloading, verify byte counts and full decoding, upload with object version/checksum, read back and confirm retention/hold configuration before acknowledging archival success. Failed or partial work remains pending or visibly failed; never advance a high-water mark past gaps.
4. Reconcile source inventory, transfer ledger and archive objects after interruption and on a schedule. Reclaim expired leases, deduplicate repeats, detect missing or altered objects, and backfill before source expiration. Durable job completion and archive receipt recording must be atomic/idempotent.
5. Produce separately keyed playback derivatives with provenance linking to originals. A timeline contains exact verified intervals, gaps and unknown intervals; never fill gaps with stills or stretched timestamps.
6. Serve the dashboard from Vercel as the control and viewing surface. Reuse Growlink's room conventions and proven UI components after the briefs and camera mapping are available. Keep the current production deployment until separate acceptance and promotion.

## Retention and evidence

Use a 90-day archive target with a non-reducible 60-day floor for required recordings. For approved local-recorder evidence, the supplied architecture proposes an originals lock from ingestion: retain until at least the later of ingestion + 90 days and the latest capture timestamp + 60 days. Do not irreversibly lock Ring data while vendor retention/deletion clearance remains unresolved. Block deletion for any overlapping active or pending investigation hold, including late-arriving footage; preserve affected native recordings before rolling recorder expiry. Holds need scope, case reference, reason, named approver and auditable release authorization; expiration alone does not release a hold. Verify provider protection, not merely displayed settings.

Original evidence stays separate from derivatives. An evidence package should contain native footage/authentication data and verifier, standard playback copy, manifest with UTC ranges and timezone, camera/source identity, SHA-256 and byte counts, export purpose/request ID, named operator, export time, gaps and verification result. A server-signed manifest attests to handling since receipt; it cannot create camera-origin authenticity or resolve acceptance of a proprietary evidence format. Verify the format with OCM and the recorder vendor before release.

Controlled deletion requires authorized staff, eligibility checked again at execution, no active hold, immutable-retention expiry, recorded reason, and preferably a second named approver. Reconcile the tombstone against storage confirmation; do not delete required footage when metadata or storage state is uncertain.

## Access and audit

Replace the shared dashboard password for security evidence workflows with named identities and MFA for owner administration through a selected identity provider. Roles: owner, operator, technician, auditor and inspector. Technicians cannot release holds; inspectors cannot change configuration. Use server-side authorization per site, camera and action. Keep credentials in server/worker secret stores with rotation and least privilege.

An inspector grant is tied to a named person and request, authorized camera/time scope, purpose, explicit owner authorization, expiry and immediate revocation. Recheck scope on every playback/export request; avoid permanent broad access or public video links. Resolve OCM's immediate-viewing expectation against Ring's vendor-policy constraints before enabling Ring inspector access.

Append audit records for authentication, grants/revocation, footage access/export, transfer verification, holds, attempted/actual deletions, configuration changes, and commissioning. Protect and independently checkpoint audit records against alteration. Access and audit status must be independent of camera online status.

## Four statuses per camera

| Status | Required evidence |
|---|---|
| Capture | Recorder/camera recording state plus fresh recorded-frame/interval evidence; stale or absent evidence is unknown/failure |
| Archive | Latest independently verified object and complete transfer intervals, including backlog/gaps |
| Retention | Verified storage protection and continuous coverage age versus 90-day target/60-day floor; holds shown separately |
| Access | Named authorized principal, camera permission and current successful playback/export health; online does not establish access |

## Independent failure monitoring

Use the briefs' proposed 30-second direct edge heartbeats, a 90-second missing-heartbeat fault, and recording-freshness checks every 30-60 seconds where supported. Target detection within 120 seconds and dispatch within 30 seconds, leaving margin for receipt and escalation within five minutes. Measure failure-to-receipt, not just scheduler execution. Monitor capture, recorder/storage, archive worker, backlog/source expiry, token renewal, archive verification, retention policy, time synchronization, power and notification delivery. One-hour archive-lag targets and six-hour backlog escalation do not delay immediate archive-failure alerts. Vercel or the dashboard failing must not disable the watchdog. Ring monitoring scope requires vendor clarification.

Recipients and a provider are not configured. No five-minute delivery claim is valid until power, internet, recorder, worker, archive, auth and dashboard failures have been injected and end-to-end receipt recorded. A separate watchdog must also detect silence from the primary monitoring process.

## Commissioning records

Maintain inspection records with date, named inspector, assets/cameras, last/due dates, results, defects, corrective work, closure and evidence references. Maintain at least five years of required security-test records under a separate policy from video deletion.

Power commissioning records need UPS/generator identifiers, complete connected-load inventory and measured watts, test start/end, utility-disconnection method, runtime, camera/recorder/network/alarm continuity, automatic recovery, failed intervals, notification receipts, battery condition and sign-off. Record an actual full-load eight-hour test or approved evidence, not a calculated claim. Site safety and the approved electrical/security design govern commissioning.

## Unresolved acceptance items

- Both design briefs are reviewed; licensed areas, operations schedule and approved security plan still need site evidence.
- Confirm exact license applicability, inspection/evidence expectations, permitted footage formats, timestamp requirements and relevant local rules with qualified reviewers.
- Obtain Ring's explicit 24/7 API export/limits/retention/consent-withdrawal/inspector-access position, or select and validate a commercial recorder.
- Provision nonproduction identity, durable queue/database, immutable archive and independent monitor; do not point preview services at production write credentials.
- Demonstrate real source continuity, restart/reconciliation, native evidence validation, held-footage protection, role isolation, scoped inspector playback, 60/90-day policy and independent alert/power behavior.

No component or document in this branch asserts that the premises or system is OCM-compliant.
