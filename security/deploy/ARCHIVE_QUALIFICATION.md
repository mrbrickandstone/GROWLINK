# Supervised storage qualification

Prepared October 15, 2026. **No live provider test has been run.** The Backblaze B2 recommendation remains conditional; AWS S3 remains an alternative. This tool checks an existing dedicated test bucket with generated JSON bodies, never Ring footage. It creates no bucket, account, lifecycle rule or paid subscription. Obtain approval for the specific plan and its small storage/API charges before running it against a real account.

## Why the exact adapter must be tested

Backblaze documents version IDs and server-side AES256 encryption, and supports compliance/governance retention and legal holds. The examined Put/Head documentation does not settle all of this adapter's checksum and conditional-write behavior. That omission is not proof of incompatibility. Keep the current checks intact and obtain actual results before selecting B2 for required footage. [B2 Put Object](https://www.backblaze.com/apidocs/s3-put-object), [Head Object](https://www.backblaze.com/apidocs/s3-head-object), [Object Lock support](https://www.backblaze.com/docs/cloud-storage-enable-object-lock-with-the-s3-compatible-api).

The test uses the production S3 adapter for preservation, complete readback, retention extension, holds and exact-version deletion. Additional direct SDK calls challenge conditional writes and deliberately wrong checksums. A checksum rejection must return `BadDigest`, not an arbitrary 400 error that might merely mean an unsupported request. [AWS upload checksum behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).

## Prerequisites and private configuration

Use a **dedicated synthetic-test bucket**, with versioning enabled, Object Lock enabled and **no default retention**. No test reconfigures those settings. This combination permits an unlocked baseline deletion test alongside a deliberately locked sample. Never disable retention on an existing evidence bucket to satisfy these prerequisites.

Supply a dedicated key with only the test bucket's needed permissions: read bucket versioning/lock/ACL; list object versions; put, head and get objects/versions; read/write object retention and legal holds; and delete specific versions. No governance bypass or bucket/lifecycle administration is requested. The same principal must successfully delete an unlocked test version before a denied locked deletion counts as evidence. Use the provider's supported permission model; no policy has been provisioned by this tool.

Copy [archive-check.example.json](archive-check.example.json) outside the repository, fill it privately and restrict it to mode 0600. The loader requires explicit scoped access-key credentials and does not inherit credentials from the shell, an instance role or a local AWS profile. It rejects symlinks, hard links, non-private permissions, unexpected keys, HTTP endpoints, URL credentials/query strings and incomplete settings. Do not paste credentials into chat or command arguments.

## Review the plan before writes

Choose a new private run directory:

```sh
node security/deploy/check-archive.cjs plan /private/path/archive-check.json /private/path/new-run
```

This makes **zero network requests**. It generates three unique bodies totaling less than 1 KiB and a private `plan.json` with the exact target, object keys/checksums, intended operations and retention timestamp. Credential values are excluded. Review that file and the target's costs/access before approving a run.

The plan expires after 30 minutes. It proposes one COMPLIANCE-protected synthetic version until 25 hours after preparation, then a one-minute extension. This is an operational test duration, not the 60/90-day footage policy. A compliance lock cannot be shortened as a cleanup shortcut. After expiry, create a new plan rather than editing its timestamps. The runner rejects changed target/effects, stale plans, altered bodies and unsafe file references before making any provider request.

After approval of that exact plan, record a non-secret decision reference:

```sh
node security/deploy/check-archive.cjs run /private/path/archive-check.json /private/path/new-run APPROVAL_REFERENCE
```

The reference is an audit record, not a source of purchasing permission. Do not run this step merely because a plan exists. The test leaves the protected synthetic version stored after completion and can leave unexpected versions after a failed provider check. Review those specific versions later; do not delete a bucket or unrelated contents.

## Actual checks and results

1. Read bucket versioning, Object Lock and ACL, reject default retention or non-owner ACL grants, and require each random test key to be absent. The ACL check does **not** establish effective privacy through all bucket policies or other access paths.
2. Upload an unlocked sample with the production adapter, verify complete bytes and confirm encryption/version metadata. Repeat preservation and require the same version.
3. Attempt a conditional duplicate write and require 412 with no extra version. Attempt the third body's upload with a deliberately wrong checksum and require `BadDigest` with no object created.
4. Write different generated bytes as a second unlocked version of the first key. Verify both pinned versions despite the changed latest version. Delete the first exact version while proving the other survives, then delete the second.
5. Upload the locked sample, extend retention and verify the same version's COMPLIANCE protection. Apply and read back its legal hold, require deletion denial, then release **only that synthetic test hold** and confirm OFF. Attempt shortening and deletion again to check COMPLIANCE protection without the hold.
6. Reverify the protected original and inventory the exact test keys. Successful completion leaves just the expected locked version. Incomplete or unexpected final inventory cannot pass the contract checks.

Each operation has a 30-second request bound; full-byte adapter readback retains its separate two-minute bound. `result.json` is saved privately throughout the run with step outcomes, original receipts, observed versions and unresolved gates. Provider error text and credentials are not printed. Exit 0 means these sample contract checks passed; exit 2 means a completed failed run; exit 1 means invalid setup or an interrupted/unsafe invocation.

The result **always leaves `qualificationPassed: false`**. Still required: effective bucket privacy, post-retention-expiry deletion of the exact test version, provider and credential independence, sustained workload/bandwidth/cost, real retry/crash/reconciliation tests, access separation, restoration after host loss and source/vendor/site-policy acceptance. A short synthetic test cannot establish 60/90-day retention or OCM compliance. Preserve the result and compare it against those remaining gates.

## Failure or interruption

`RUN_STARTED` prevents replay of the same plan, including after a hard kill or unknown provider outcome. The tool does not silently retry a new run or automatically clean up uncertain writes. Keep the plan, marker and result. A step left `running` is an unknown outcome, not a success or confirmed failure. Inspect only the exact recorded keys/versions with approved read access, determine what happened and prepare a separately reviewed recovery or new test. Inventory failure also remains explicit.

After the recorded retention deadline, separately verify that the exact synthetic version is no longer locked or held before attempting approved version-specific removal. Confirm that version is absent afterward. This delayed check has not been run and is not automated. Never clear an actual investigation hold or weaken real-footage retention to complete a test.

## Local verification only

Six automated tests validate private configuration, zero-network planning, complete synthetic contract flow, target/body/plan integrity, rejection of twelve weaker/error provider behaviors and recovery from an actual killed test process. Altered conditional/checksum/version/hold/retention behavior cannot yield a passing result. Raw provider errors, including an uppercase secret sentinel, remain excluded. Tests use in-memory SDK responses and temporary local files; they do not establish B2 or S3 behavior on an actual account.
