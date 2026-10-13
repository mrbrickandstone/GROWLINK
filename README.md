# GROWLINK

Farber Growlink dashboard for INTERM FLOWERING, recovered from the production Vercel deployment on October 8, 2026.

## Status

The recovered baseline's nine application files matched the source hashes from deployment `dpl_4Z74CZwMZJahuyYBHuzpZZFb9aRv`. The monitoring branch adds files and updates test/function configuration. This README replaces the deployment README, which could not be retrieved completely.

The dashboard reads live sensor data and history from Growlink and outside temperature observations from NWS station KHWV. It refreshes while the dashboard is open. Background monitoring and email alerts are implemented on this branch but are not active. No equipment-control endpoint is exposed.

## Configuration

Set these environment variables in the Vercel project:

- `GROWLINK_API_KEY`: Growlink API key, stored as a sensitive variable.
- `DASHBOARD_PASSWORD`: private dashboard password, stored as a sensitive variable.
- `GROWLINK_ORG_ID`: optional organization override; otherwise the mapping in `config.cjs` is used.

Keep credentials in deployment environment variables. Do not commit secrets or live sensor exports. The browser uses the dashboard password to authenticate to the backend; the Growlink API key stays on the server.

The existing Vercel production deployment has not been changed or connected to this repository as part of the source import.

## Validation

Run `npm test` with Node.js 22 or newer. The recovered package has no third-party runtime dependencies. Tests verify the sensor mapping, authentication requirements, supported history ranges, API request headers, and API-key privacy using mocked upstream responses. These tests do not confirm access to live Growlink data.

## Next work

The monitoring branch adds a read-only monitor with persistent incident state, bounded snapshots, and email delivery. See [MONITOR_SETUP.md](MONITOR_SETUP.md) for activation requirements. It is disabled by default and not deployed. Camera access will follow after Growlink monitoring is working.

## Security archive pilot (development only)

The isolated security work starts with the official Ring historical-export pilot.
See [findings](docs/security/PILOT_REPORT.md), [runbook](docs/security/RUNBOOK.md),
and [proposed architecture](docs/security/ARCHITECTURE.md). Both supplied PDFs are
reviewed in the [brief reconciliation](docs/security/BRIEF_RECONCILIATION.md).
Run `npm run pilot -- preflight` before attempting inventory or exports.
Live official inventory and token refresh succeeded through an expiring metadata bridge.
The owner reports upgrading the plan and enabling 24/7 for camera “1”; only later quiet periods are eligible for the pilot.
Quiet historical exports and exact target coverage with planned overlap have now been
demonstrated on eight files, along with token refresh, a clean restart and actual
interrupted-transfer recovery after lease expiry. See the
[final evidence register](pilot/results/2026-10-13-pilot-final.json).
No primary archive source or compliance claim has been approved. The agent made no purchase or camera-setting change.
