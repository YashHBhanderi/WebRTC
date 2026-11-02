# Time synchronisation (deployment prerequisite)

Clerk session tokens are verified locally against the server's clock, with a 5-second tolerance in production. A server whose clock is off by more than that:

- **slow:** rejects every valid sign-in. Clerk issues `nbf = iat − 10 s`, so at 16 s slow the token is "not active yet" (`token-not-active-yet`), and `iat` alone is "in the future".
- **fast:** keeps accepting expired tokens for the drift, which stretches the sign-out window.

The application **never** loosens token validation to compensate. The tolerance stays 5 s in production (`src/config/auth.ts`; `check:config` fails above 30 s).

## Measured on the development host (2026-10-26)

| Item | Value |
|---|---|
| Offset vs `api.clerk.com`, `www.google.com`, `aws.amazon.com` (HTTPS `Date`) | **−15.9 s, −16.1 s, −16.5 s** (±0.9 s) |
| Windows Time | Type `NT5DS` (domain hierarchy, by policy); source `dcserver.sit.local`; stratum 2; "last successful sync" today |
| Conclusion | The host is synchronised **to a domain controller that is itself about 16 s slow** (it was about 10 s slow on 2026-10-22). Not changed by us. |

**Required correction (domain administrator):** point the PDC emulator of the `sit.local` domain at a reliable external NTP source, e.g.:

```
w32tm /config /manualpeerlist:"time.windows.com,0x8 pool.ntp.org,0x8" /syncfromflags:manual /reliable:yes /update
```

Then `w32tm /resync /rediscover` on the PDC, and verify on clients with `w32tm /query /status` plus `npm run check:clock`. Owner: domain or infrastructure administrator.

## Production hosts

| Platform | Setting | Verify |
|---|---|---|
| Linux VM | `chrony` (preferred) or `systemd-timesyncd` enabled, with reachable NTP servers (cloud providers offer link-local ones, e.g. AWS `169.254.169.123`) | `chronyc tracking` (offset < 0.1 s), `timedatectl` ("System clock synchronized: yes") |
| Containers | Use the host clock (containers cannot set time): fix the node | as above, on the node |
| Windows Server | `w32tm` with a reliable source (domain PDC synced externally) | `w32tm /query /status` |

## Monitoring (implemented)

- `npm run check:clock`: read-only HTTPS `Date` comparison against the token issuer (default `https://api.clerk.com/v1/jwks`; override with `CLOCK_REFERENCE_URL`, https only). Prints the offset and `PASS` / `WARN` / `FAIL` (fail beyond 3 s). Exit code 1 on FAIL. No credentials.
- **Runtime:** each instance measures at startup and every 15 minutes (`CLOCK_CHECK_INTERVAL_MS`). Beyond 3 s it logs an error naming this document. The last reading appears in `GET /health/ready` as `clock: { level, offsetMs }`.
- Clock drift does **not** fail readiness: it usually affects every host at once, and taking them all out of the load balancer would turn an auth problem into a full outage. Alert on the log or readiness field instead.

## Tests

`test/token-validation.test.ts` exercises the **real** `@clerk/backend` verifier with the production tolerance (not the test double). It covers:
- valid;
- issued in the future (as from a 16 s slow host);
- `iat` in the future;
- expired, beyond and within tolerance;
- `nbf` in the future;
- forged;
- tampered;
- `alg=none`;
- algorithm confusion (HS256 with the public key);

plus the offset diagnostic's measurement and grading.
