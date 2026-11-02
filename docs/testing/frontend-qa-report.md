# Frontend QA report (Phase 5B)

Date: 2026-10-22. Angular app on `http://127.0.0.1:4300` against the staging backend, real Clerk test instance, Chromium 130 (headless, Playwright).

## Browser walkthrough: what was exercised

| Flow | Result | Evidence |
|---|---|---|
| Login via Clerk's SignIn form (email → password → new-device email code) | Pass | 6 users, repeated runs |
| Login rejected when the origin is not an authorized party | Pass (correct refusal; the app returns to login) | `token-invalid-authorized-parties` in the backend log |
| Personal user lands on `/chat` with no workspace | Pass | |
| Workspace switcher: lists orgs, switches with a full reload, the token org follows | Pass | Org B → Org A → Personal |
| Stale state after switching | Pass at the API level (the OrgA conversation is refused in OrgB or Personal). The UI reloads fully by design. | |
| Chat list shows a conversation once it has a message | Pass | Empty conversations are hidden (by design) |
| Direct video call: start, ring, accept, both videos live | Pass | 3/3 video elements playing on both sides |
| Recording: confirm dialog, REC indicator for the peer, stop | Pass | |
| Console errors during those flows | 0 | |
| Failed API requests during those flows | 0 | |

**Not exercised in a browser this phase:**
- logout;
- group calls and screen share;
- the developer dashboard screens (registration, credentials, webhooks);
- workspace admin;
- connected apps (their APIs were tested directly);
- expired-session UX;
- keyboard accessibility;
- responsive layouts.

These remain open.

## Defects found

| # | Severity | Defect |
|---|---|---|
| F1 | Medium | **An incoming call is lost if it arrives while the socket reconnects at startup.** `connectWithToken()` disconnects, then connects, and runs more than once. Pending rings are not re-sent. See the integration report. |
| F2 | Low (dev configuration) | `environment.ts` uses an http `apiUrl` while dev is served over https, so the browser blocks requests as mixed content. Dev setups must use matching schemes. |

## Automated UI tests (Karma / Jasmine, existing tooling)

New specs, all passing (7/7):
- `pages/developer/consent-page.component.spec.ts` (6 tests):
  - nothing pre-selected;
  - Allow disabled until a permission is ticked;
  - sensitive flag shown;
  - only the ticked subset is sent;
  - wrong context blocks approval, even with a permission set programmatically;
  - development-app warning;
  - invalid or expired request.
- `pages/shell/workspace-switcher.component.spec.ts` (1 test): a server-refused switch falls back to Personal and shows the server's message.

Mutation check: removing the context guard from the Allow button makes a spec fail. The first version of the test missed this (OnPush re-render); it was corrected.

**State of the existing suite:** 26 specs. 12 fail and 2 are skipped, all unmodified Angular CLI scaffolds that predate this work. Two of them did not compile at all (`authGuard`, `ChatNewComponent` renamed long ago), which blocked every Karma run. They now compile and are marked `xdescribe` with an explanation. The other 12 failures (missing providers, old template text) are not fixed here.

Run: `CHROME_BIN=<chromium> npx ng test --watch=false --browsers=ChromeHeadless`.

## Build

`ngc -p tsconfig.app.json --noEmit` passes. `ng build` succeeds with the existing initial-bundle and component-style budget warnings.

The bundle was not optimised: no performance bottleneck was measured in this phase. Baseline initial total 1.18 MB against a 500 kB budget (unchanged).
