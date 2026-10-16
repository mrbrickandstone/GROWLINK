# Southampton Mac mini staging handoff

Prepared October 15, 2026 for the owner's separate **MARCOS-MAC-MINI**, identified by the owner as **Mini-deMarcos.home**. The owner reports it is new and available, but its Codex connection is offline and the supplied hostname does not resolve from the development Mac. Its chip, RAM, storage, network, power settings and remote access have **not been inspected**. This task currently exposes only the development Mac; observations from that Mac are not evidence about Southampton.

## Selected approach and estimated costs

Use the existing Mac mini for a bounded staging evaluation of the worker and dashboard. Use **Backblaze B2 as the candidate independent original archive**, subject to the live API qualification below, and a **DigitalOcean 1 GB / 1 vCPU / 25 GB Basic Droplet** for the existing watchdog. The watchdog must be outside the Southampton power/network failure domain. An additional external deadman check must detect failure of the watchdog itself. No accounts, servers, buckets or paid resources have been created.

| Item | Illustrative monthly cost | Status |
|---|---:|---|
| Existing Mac mini | No additional cloud compute charge | Electricity, network, disk and UPS excluded; capacity unverified |
| B2 originals at 4.4 decimal TB | About $30.58 | $6.95/TB/30 days; actual byte-hours determine billing |
| DigitalOcean external watchdog | $6 | Region/plan availability and measured memory use must be confirmed |
| Base total at that stored volume | About $36.58 | Excludes backups, notification service, identity, domain, taxes, holds and extra downloads |

The 4.4 TB estimate extrapolates three cameras from the short camera-1 sample at roughly 1.5 Mbit/s, not a measured retention requirement. B2 advertises free egress up to 3× average monthly storage, then $0.01/GB. Scheduled full-byte archive checks default to every seven days (`SECURITY_ARCHIVE_VERIFY_HOURS=168`) and consume downloads; benchmark the provider and set an approved cadence/bandwidth budget before unattended operation. This interval does not provide five-minute corruption detection. See [archive reconciliation](../../docs/security/TRANSFER_MONITORING.md#scheduled-archive-reconciliation). Sources checked October 15: [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [B2 transaction/egress pricing](https://www.backblaze.com/cloud-storage/transaction-pricing), [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets). Obtain approval for the exact recurring cost before provisioning.

B2 documents version IDs, AES256 server-side encryption and retention/legal-hold headers. This is **not proof that our exact S3 adapter works against B2**. Its conditional `If-None-Match`, SHA256 headers, version-specific readback, retention extension, legal holds and deletion checks still need a live disposable synthetic-file integration test. The [supervised qualification runner](ARCHIVE_QUALIFICATION.md) now prepares an exact local plan and private result ledger, but has only been tested with in-memory provider responses. Keep the current fail-closed checks; do not weaken them to make a provider appear compatible. Use a private bucket, scoped application keys and no automatic lifecycle deletion. [B2 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [Put Object](https://www.backblaze.com/apidocs/s3-put-object). Ring policy decisions remain required before exporting or locking real footage.

## Host screening

Start with 8 GB RAM or more and at least 200 GB free on a persistent encrypted local volume for a **bounded one-camera staging run**. These are engineering screening thresholds, not vendor minimums or production sizing. Target 16 GB RAM if available, then measure software H.264 encoding and recovery backlog. The implementation uses `libx264`, not Apple hardware acceleration.

Run on the actual Mac mini after Node 22.16+ and FFmpeg are installed:

```sh
node security/deploy/check-host.cjs "/Library/Application Support/Farber/data"
```

The directory must already exist; otherwise use the intended existing parent volume. Exit 2 means a failed or unavailable screening check. The command reads capacity, dependencies and power settings; it does not read credentials, contact services, change settings or qualify the system. `screeningPassed` never sets `productionReady` true.

Use wired Ethernet. Disable automatic computer sleep while allowing display sleep; verify restart after power loss on this model. The UPS must cover the Mac, router, network equipment and cameras. Keep encryption enabled and test a real cold boot: FileVault/unlock requirements can delay unattended recovery. A launch daemon starts independently of a logged-in desktop once the OS is running; this does not bypass disk unlock. Document the recovery procedure and an available responder. [Apple power settings](https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac), [Apple login restrictions](https://support.apple.com/en-au/102316), [launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

At 1.5 Mbit/s, one camera produces about 16.2 GB/day of originals; three produce 48.6 GB/day. By default the worker retains local staging files and playback derivatives. **200 GB is not a 90-day local archive.** A seven-day three-camera run would already exceed it before derivatives. Start with a supervised, bounded test, explicitly stop the worker at its end and measure growth. Before unattended rollout, commission the implemented backlog/source-window alarms and [verified cache cleanup](../../docs/security/CACHE_AND_PLAYBACK.md), or supply measured adequate local capacity, and validate catch-up throughput. Cleanup requires a qualified independent immutable archive and remains disabled in the service template. Do not manually delete evidence files to recover space.

Disk safeguards now use `SECURITY_MIN_FREE_BYTES` (default 20,000,000,000; minimum allowed 1 GB). They warn at twice the reserve, stop admission below reserve + 1 GiB job headroom, and resume above 1.25× reserve + headroom. At the default, admission resumes at about 26.1 GB free. Download, restore and local-copy streams check space before writes; playback processes are checked every two seconds and interrupted on pressure. A missing capacity reading fails closed. The paused state is restored across restarts, and deferred jobs retain identity and prior source-retry counts. A warning or pause is reported through the existing independent watchdog heartbeat; actual notification receipt is still untested.

The guard measures available space on the data filesystem; keep staging, derivatives, the local review archive and database on that same filesystem, without separate subdirectory mounts or quotas. It is a protective margin, not a reservation against unrelated processes filling the disk or a guarantee of recovery from filesystem failure. Archived originals are never removed by cache cleanup; only freshly verified protected duplicates qualify. Held footage, thumbnails, unknown alternate bytes and abandoned temporary files still require capacity. Space recovery, cache settings, archive-provider verification, alert delivery and volume sizing remain commissioning work.

## Portable release

From a reviewed committed checkout:

```sh
node security/deploy/release.cjs /private/tmp/farber-staging.tar.gz HEAD
```

The archive and adjacent manifest contain the commit ID, byte count, SHA256 and file inventory. Only allowlisted committed runtime/docs paths are included. Private media, databases, real service configs, node_modules and working-tree changes are excluded. Transfer over the owner's existing trusted connection, compare the archive SHA256 with the manifest obtained from the trusted source, extract to a new release directory, and run `npm ci --prefix security --ignore-scripts` there. The checksum manifest detects transfer changes; it is not an independently signed release provenance assertion.

## Install only on the confirmed target

An administrator should create a dedicated non-admin `_farber` account and group, with no interactive login, using a locally available UID/GID rather than a hard-coded number. The templates assume:

- Root-owned, service-readable code at `/opt/farber`, not writable by `_farber`.
- `_farber`-owned mode-0700 data at `/Library/Application Support/Farber/data` on local APFS, outside iCloud/Dropbox/network shares.
- A root-owned non-writable configuration directory, with role-specific files `/Library/Application Support/Farber/config/worker.json` and `web.json`, each owned by `_farber`, mode 0600. Copy the key-only examples outside the repository and fill values privately. The loader rejects symlinks, group/world access, unexpected keys and invalid JSON without logging values. Web config excludes Ring credentials. Use distinct scoped storage keys for the read-only web service and upload/hold worker.
- `_farber`-owned mode-0700 `/Library/Logs/Farber`, with protected log rotation configured before operation. Never log environment dumps, OAuth callback query strings or bearer headers.
- Node at `/opt/homebrew/bin/node` on Apple Silicon. On Intel, verify the installed executable and adjust both plist files (often `/usr/local/bin/node`). Verify `_farber` can execute Node/FFmpeg and read installed dependencies. Do not grant it write access to code or tool binaries.

Initialize room labels as `_farber` with the data directory supplied, without moving pilot footage or enabling Ring:

```sh
sudo -u _farber env SECURITY_DATA_DIR="/Library/Application Support/Farber/data" \
  /opt/homebrew/bin/node /opt/farber/security/cli.cjs init-site
```

Provision named users with `cli.cjs add-user` and a private user-definition file as described in [the main README](../README.md). Configure a private HTTPS origin/TLS reverse proxy and OIDC callback. Leave the web server on loopback; never forward a `--review` port to the internet. The TLS/domain/network access configuration must be chosen and tested on the actual host; it is not bundled as a preconfigured public endpoint.

After prerequisites and restricted service configs are verified, install the two plists as root:wheel, mode 0644 under `/Library/LaunchDaemons`. They contain paths and a service account, not secrets. Validate with `plutil -lint`, then bootstrap each service individually:

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/com.farber.security.worker.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.farber.security.web.plist
```

Do not install the watchdog on this Mac; use the existing Linux watchdog unit on the external host with its own credentials, TLS endpoint and notification recipient configuration. Follow the [independent monitoring handoff](WATCHDOG.md) for the private signed web-readiness probe and optional secondary-monitor pulse. Actual end-to-end receipt within five minutes remains untested. Export readiness lag also means worker heartbeats alone cannot prove five-minute camera-failure detection.

## Commissioning and rollback

Test synthetic media through the off-site archive first, then named sign-in and rejected unauthorized requests. Configure dedicated Ring access and the existing policy gates only after their approvals are recorded. Never re-scope existing Vercel production secrets as an installation shortcut.

Stop/restart the worker during an in-flight transfer; verify lease expiry/recovery, original checksums and timestamp coverage after restart. Independently stop the web service and establish that capture and archive transfers continue. Test internet loss, full-disk handling, reboot, UPS recovery, remote access revocation and alert receipt. Use the [backup and recovery tooling](BACKUP_RECOVERY.md) for a consistent SQLite snapshot, matching signing key, encrypted restic backup and verified quarantined restore. Commission independent storage and checkpoint custody, backup scheduling/alerts and a reviewed activation procedure on the actual host. Copying only a live WAL database file is not a valid backup.

Before any upgrade, stop both services and take that consistent backup. Keep the preceding release. To stop staging:

```sh
sudo launchctl bootout system/com.farber.security.web
sudo launchctl bootout system/com.farber.security.worker
```

Switch code only after compatibility review; a database migration requires a tested restore plan. Preserve original evidence and audit state during rollback. No install, service bootstrap, remote host change, paid resource, credential transfer or production change has been performed by preparing this package.
