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
