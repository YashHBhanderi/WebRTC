# Outbound webhook security

Scope: `webrtc-BE/src/webhooks/*`. Status: implemented and covered by local tests and mutation checks. **Not verified against real internet endpoints, real DNS or real TLS** (see "Unverified").

## Threats and controls

| Threat | Control | Where |
|---|---|---|
| SSRF to internal services or cloud metadata | Production apps must use `https`. Ports are limited to 443/8443 (https) and 80/8080 (http, development apps only). Userinfo and fragments are refused, and internal-looking hostnames are blocked. IPv4 and IPv6 blocklists are enforced through `net.BlockList`. Embedded IPv4 (mapped, NAT64, 6to4) is checked as IPv4. Hostnames are parsed through WHATWG `URL`, which normalises alternate forms such as decimal, octal and hex. | `ssrf.ts` `parseDestination`, `isPublicAddress` |
| DNS rebinding (passes at configuration time, resolves private at send time) | `pinnedLookup` resolves at connection time, rejects the connection if **any** returned address is non-public, and connects to the address it checked. `agent: false` means no socket is reused. | `ssrf.ts`, `sender.ts` |
| Redirect to an internal address | Redirects are never followed; a 3xx is recorded as `redirect_not_followed`. | `sender.ts` |
| Slow or huge responses | Timeout (`WEBHOOK_TIMEOUT_MS`, default 10 s). At most 4 KB of the response body is read. | `sender.ts` |
| Leaking events across tenants | Events go only to users who (1) are conversation members, (2) hold an active grant with the scope, (3) hold a grant whose `tenantId` equals the app's, (4) pass `visibleIn` for the app's context, and (5) for tenant apps, are active members right now. External chats reach global apps only for the guest. | `events.ts` `fanOut` |
| Over-sharing | Text content only, capped at 4,000 characters. No file URLs, recordings or system payloads. 64 KB envelope cap. Endpoints can only subscribe to events inside the app's scopes. | `events.ts`, `service.ts` |
| Forged deliveries / replay | HMAC-SHA256 over `id.timestamp.body`. The receiver is told to enforce a 5-minute window and to deduplicate on the id. | `crypto.ts` |
| Theft of stored signing secrets | Secrets are AES-256-GCM encrypted with `WEBHOOK_SECRET_KEY`, which is required in production (startup fails without it). They are shown once and never logged (`swh_` is redacted). | `crypto.ts`, `config/security.ts`, `utils/safe-log.ts` |
| Endpoint not controlled by the app owner | A signed verification challenge must be echoed before activation, and again after a URL change or re-enable. | `service.ts` `verifyEndpoint` |
| Duplicates from retries or concurrent workers | Unique `(endpointId, eventId)` index. Lease-based claims (`lockedUntil`). Expired leases are recovered. | `models.ts`, `worker.ts` |
| One app exhausting the worker | Per-app in-flight cap of 5, and 10,000 pending per app. | `worker.ts`, `events.ts` |
| Webhooks slowing chat | `publish()` defers with `setImmediate`, runs in `runAsSystem` and swallows errors. Delivery is fully asynchronous. | `events.ts` |
| Permanently failing endpoint | Disabled after 15 consecutive failures, with an audit entry. Recovery requires re-enabling and re-verifying. | `worker.ts` |
| Suspended or revoked app | Suspended: deliveries pause for 10 minutes without using an attempt. Revoked: cancelled. | `worker.ts` |

## Verification done

- `test/webhooks.test.ts` (11 tests) covers:
  - SSRF address classes;
  - URL forms;
  - pinned lookup when DNS returns a private address;
  - redirect refusal;
  - signature and rotation;
  - tenant, global and external audience;
  - removed members;
  - payload minimisation;
  - idempotent enqueue;
  - lease recovery;
  - dead letters and the disable/recovery path;
  - suspension.
- Mutation checks: each control in the table that has a matching mutation was disabled one at a time, and the suite was confirmed to fail. Results are in [../implementation/phase-4c-5a-report.md](../implementation/phase-4c-5a-report.md).

## Unverified (needs a staging environment)

- Behaviour against real DNS resolvers, multiple A/AAAA answers, and a real attacker-controlled rebinding domain. The tests inject a resolver.
- TLS edge cases (invalid certificates are rejected by Node defaults; not exercised in tests).
- Egress firewall. **Recommended defence in depth:** run the worker with network egress that blocks RFC 1918 ranges and the metadata IP (169.254.169.254) at the infrastructure level. Owner: DevOps.
- Throughput with many apps or instances. Leases make concurrent workers safe in principle; multi-instance behaviour has not been load-tested.
