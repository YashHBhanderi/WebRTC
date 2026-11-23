# User consent (linking your users to SpreeWe)

An app acts for a SpreeWe user only after that user approves it on a SpreeWe-hosted page. This replaces the Phase 4B flow, in which the user's client sent `externalUserRef` directly. That flow allowed one user to claim another person's link (finding F2 in [../security/phase-5-security-review.md](../security/phase-5-security-review.md)).

## Flow

1. **Your server creates a request.** It calls `POST /v1/consent-requests` with Basic `keyId:secret`:
   ```json
   { "redirectUri": "https://app.example.com/spreewe/callback",
     "scopes": ["messages:read", "messages:write"],
     "state": "<random, bound to your user's session>",
     "externalUserRef": "<your user id>" }
   ```
   - `redirectUri` must **exactly** match one of the app's registered `callbackUrls`.
   - `scopes` must be within the app's scopes.
   - The response contains `consentUrl` (`${APP_PUBLIC_URL}/consent?request=<id>`). The request expires in 10 minutes.
2. **Send the user's browser to `consentUrl`.** The user signs in to SpreeWe if needed. The page shows:
   - the app name, its owner and its environment (development apps carry a warning);
   - the host it will return to;
   - each requested scope, with sensitive scopes flagged;
   - any scopes the user already granted.

   Nothing is pre-ticked. The user must be in the right context: their personal workspace for global apps, or the app's workspace for tenant apps, as an active member.
3. **The user approves (a subset) or denies.** Each request can be decided **once**; the claim is atomic.
4. **The browser returns to your callback:**
   - approved: `?state=…&result=approved&grant=<grantId>`;
   - denied: `?state=…&error=access_denied`.

   Check `state` against the user's session before trusting the result.
5. **Your server issues user tokens** with `POST /v1/app-tokens` (credential-authenticated, by `externalUserRef`), as described in [scoped-user-tokens.md](scoped-user-tokens.md). Each issuance updates the grant's `lastUsedAt`.

## Rules worth knowing

- `externalUserRef` is set only by your **authenticated server** when it creates the request. A user cannot change it.
- If the same `externalUserRef` is already linked to a different SpreeWe user, approval returns 409.
- Re-approving replaces the earlier scope set.
- Users see and revoke grants under **Settings → Connected apps**. Revoking stops tokens immediately.
- Workspace owners and admins can withdraw every member's grant for a workspace app (**Workspace → Workspace apps**), and can suspend the app.

## Example

`docs/integrations/examples/backend/spreewe-server-client.ts` → `startConsent(externalUserRef, scopes, redirectUri, state)`.
