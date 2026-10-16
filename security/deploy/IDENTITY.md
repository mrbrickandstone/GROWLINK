# Named sign-in and access commissioning

The dashboard uses the installed OpenID Connect client with authorization-code flow, PKCE S256, state and nonce. A disposable HTTPS issuer has exercised the actual client and application callbacks. No live identity provider or real user account has been connected; the results below are software verification, not production commissioning.

## Configuration and authorization

Set the HTTPS issuer, client ID and client secret privately using the web service's configuration. Register exactly `SECURITY_ORIGIN/auth/callback` at the provider and keep the service on loopback behind the approved TLS proxy. The issuer must provide discovery, a supported signing key through JWKS and signed ID tokens. Discovery and subsequent client network requests have a ten-second timeout.

The request asks for fresh authentication with `max_age=0`; the callback also validates the presence and freshness of `auth_time`, subject to the client library's clock tolerance. The client verifies the issuer, audience, expiry, nonce and ID-token signature. Explicit signature checking adds to the authenticated TLS token response; it does not establish camera-native evidence authenticity. See the upstream [authorization-code checks](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md) and [signature validation option](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).

Provision each exact `issuer|subject`, name, application role and camera scope with `cli.cjs add-user` and a private JSON definition. Provider role claims never assign application privileges. Owners require the provider's verified `amr` array to contain `mfa`; configure and verify that claim at the selected provider. An existing non-MFA session loses dashboard access if its user is promoted to owner. Local account disablement and role/camera changes are re-read on requests; inspectors additionally require a current request-specific camera/time grant.

Provider-side account disablement, password changes or IdP logout are **not** connected to application-session revocation. Until provider logout/revocation integration is implemented and commissioned, also disable the named user locally to remove access promptly. Do not interpret a configured issuer or a signed readiness response as proof that the provider is working.

## Session handling

The browser receives an opaque `HttpOnly; Secure; SameSite=Lax` host-only cookie at the HTTPS origin. Only its SHA256 digest is stored as the database lookup key. CSRF tokens and exact Origin checks protect writes. A login flow expires after ten minutes and is consumed atomically before exchanging a code, so concurrent callbacks cannot both use it. The callback clears the flow cookie.

Successful sign-in replaces the session supplied by that browser in the same transaction as creation and audit of the new session. It does not revoke other devices' sessions. Session and cookie lifetime are bounded by the earlier of eight hours or the ID-token expiry. Dashboard sessions persist across a web-process restart but do not renew automatically. Logout removes the current local session; it does not log out the IdP. Access tokens, refresh tokens, ID tokens and client secrets are not stored in session or audit records. Ring worker authentication is separate.

## Demonstrated checks

Seven isolated HTTPS scenarios use the installed OIDC library with a local RSA-signed issuer and trusted disposable certificate. They cover successful named login, signing-key retrieval, secure cookie lifetime, session replacement, CSRF and logout; rejected signatures/issuer/audience/expiry and absent/stale authentication time; state/nonce/PKCE, concurrent callback use, replay and expired flows; explicit provisioning, owner MFA, promotion and disablement; persisted sessions across web restart and expiry; inspector scope and immediate local grant revocation; and recovery after failed issuer discovery.

The fixture runs with a restricted child environment, generated identities and no real account credentials. Some broader HTTP authorization tests still inject test principals. Neither approach proves live-provider policy, actual MFA enrollment, browser cookie/proxy behavior or externally revoked identities.

## Required live checks

With the selected provider and actual host, record named owner/operator/inspector sign-ins, owner MFA claims, exact HTTPS callback/proxy/cookie behavior, rejection of unknown users, local disablement and role changes, scoped inspector access and expiry/revocation, session expiry/logout, provider outage and recovery. Use two distinct owner identities for deletion approval. Confirm clock synchronization and maintain a controlled local account-disable procedure. No provider account, client, user or paid service has been created by this work.
