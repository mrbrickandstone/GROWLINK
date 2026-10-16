# Local cache and archived playback

Implemented and tested in development on October 15, 2026. **Automatic cleanup is disabled by default and has not run against real footage.** This feature does not qualify a recording source or establish retention compliance.

## What can be cleared

`SECURITY_ENABLE_CACHE_EVICTION=true` opts the worker into checking at most five eligible segments every five minutes, including while low disk space pauses new transfers. `SECURITY_CACHE_KEEP_HOURS` defaults to 24, with an allowed range of 1–720 hours. Time is measured since ingestion, latest playback reconstruction or most recent playback request/access, whichever is newest.

Every cleanup requires all of the following:

- A verified original with a matching independent, versioned, immutable archive receipt; a local review archive cannot qualify.
- Fresh full-byte SHA256/size readback of that exact archived version, and fresh COMPLIANCE retention metadata covering the later of 90 days after ingestion, 60 days after the footage ends, and one day after the check. The storage-lock gate must already be approved. Verification performs no retention extension or archive mutation.
- For Ring, an approved retention policy and recorded decision reference. Technical ability does not resolve vendor policy.
- No overlapping pending/active investigation hold, requested/approved deletion, active associated job or recent playback access.
- Exact expected managed paths, private regular files without symlinked parents or multiple hard links, and matching byte hashes.

Only the known staging original, an old managed resume copy, and the recorded playback MP4 are candidates. Thumbnails, imported source files, `.pilot` footage, alternate response bytes and archived originals are preserved. Unknown or altered local files require review; they are not silently removed. Local duplicate removal is separate from controlled deletion of archived evidence.

The worker journals its intent before unlinking and rechecks holds, access, jobs, receipt and file identity in a short database transaction immediately before local removal. A restart reconciles a missing playback file after an interrupted prepared eviction. Verified original coverage remains credited; the timeline marks the playback copy as unavailable, rather than fabricating a recording gap. Failed checks leave files in place and enter the worker/watchdog fault path. This is not proof of notification delivery.

## Rebuilding playback

A named viewer with current playback permission can select **Prepare playback**. The authenticated, CSRF-protected request creates one durable job per segment and a 15-minute authorization request. Multiple viewers reuse that job. The worker reloads enabled users, role/camera scope, owner MFA and inspector grants before processing and again before publishing. A revoked or expired request cannot authorize completion; another still-authorized request may do so. Playback HTTP requests continue to check their own current permissions.

The worker downloads the preserved original from its recorded archive version, verifies the full expected size and SHA256, and builds the separate 720p playback derivative. It does not ask Ring for new footage or start live view. Original transfers and playback jobs for the same segment cannot claim overlapping active leases. Partial, altered or oversized archive bodies fail before encoding. Handled failures remove the temporary download; a hard process kill can leave a private temporary file for subsequent maintenance review. This release does not sweep arbitrary abandoned temporary files.

The browser polls for up to one minute and then offers another status check. The durable job continues independently of the dashboard. If authorization expires before the worker can process it, a new authorized request is needed. Rebuilding is also blocked when disk admission is paused. Evidence exports continue to use archived originals, not playback derivatives.

## Demonstrated tests and limits

Fourteen additional automated checks cover default-off/local-only refusal, holds and access races, damaged/protection-failed archives, exact-version retention metadata, symlink/hard-link/replacement refusal, prepared-eviction restart recovery, job deduplication and serialization, real FFmpeg rebuild after lease recovery, request expiry/revocation, revocation during readback, short/altered/oversized responses and authenticated HTTP scope/CSRF enforcement. The full repository suite passes 100 tests.

A browser test used a separate generated two-second pattern and a disposable named test principal on loopback. The UI progressed from **Prepare playback** to **Playback copy ready**; the video reached readyState 4, played to 2.000 seconds and ended without a media error. No warning/error console entries were captured. This does not test a live identity provider or remote archive. The private screenshot is `.security/review/playback-rebuild.png`.

Before enabling cleanup on the Mini, qualify the actual provider's versioning, lock metadata and full readback; resolve Ring retention policy; test these races and restart behavior on the target filesystem; measure download/encoding throughput, storage growth and bandwidth costs; and prove independent alert delivery. Held footage, thumbnails, unknown alternate bytes and abandoned temporary files still consume disk. Keep the disk guard enabled and size capacity for those cases. No 60/90-day history or OCM compliance is established by these tests.

The S3 protection check uses the documented [HeadObject exact-version and Object Lock metadata](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html). S3-compatible providers must demonstrate this contract; support is not assumed from API similarity.
