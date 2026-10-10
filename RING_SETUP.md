# Farber Ring cameras

The integration uses Ring's official one-way account linking and WHEP live video. It is private to the dashboard owner and uses the existing dashboard password. Credentials and encrypted OAuth tokens stay on the server; no Ring password is stored.

## Production credentials

Set RING_CLIENT_ID, RING_CLIENT_SECRET and RING_HMAC_KEY in Vercel Production. Existing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL / KV_REST_API_TOKEN provide storage. Redeploy after environment changes.

## Ring portal URLs

| Field | Value |
| --- | --- |
| Token Exchange URL | https://farber-growlink-dashboard.vercel.app/api/ring?action=token |
| Account Link URL | https://farber-growlink-dashboard.vercel.app/ring-link.html |
| Webhook URL | https://farber-growlink-dashboard.vercel.app/api/ring?action=webhook |
| App Homepage URL | https://farber-growlink-dashboard.vercel.app/ |

Use the private app's connection/test link supplied by Ring. Authorize only the three intended cameras, then enter the dashboard password on the Farber linking page. A success message confirms linking. Open the dashboard, sign in and select View live on a camera.

## Behavior and verification

- Viewing is user-initiated, video only. Streams stop when the tab is hidden, locked or closed; sessions also stop after ten minutes. Network restrictions can prevent WebRTC even when account linking succeeds.
- Camera names and online status come from Ring. No video is archived by this dashboard.
- Tokens are encrypted with AES-256-GCM, using an HKDF key derived from the Ring client secret. Rotating that secret requires clearing/relinking the Ring connection. A Redis lock serializes refreshes and account linking.
- Access tokens refresh on camera requests. After approximately 30 days without usage, Ring may require re-linking. This integration does not yet run a background token refresh.
- Account linking requires both the dashboard password and a valid ten-minute Ring nonce. Pending tokens expire after ten minutes. Signed unlink webhooks remove the active stored connection.
- Server tests mock Ring/Redis to check auth, nonce expiry/replay, encryption, token refresh and session lifecycle. Actual Ring account linking and video must be checked using the three installed cameras after portal configuration; mocked tests are not proof of a live feed.
- Ring's inbound code handler accepts JSON or form-encoded code / authorization_code. Validate delivery against the private app connection flow. Webhook verification uses the original request bytes.

Reference: https://developer.amazon.com/docs/ring/api-documentation.html
