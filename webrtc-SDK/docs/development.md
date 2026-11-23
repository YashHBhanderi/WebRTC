# Building, testing and releasing

The workspace is `webrtc-SDK/` (npm workspaces). Node 18.17+ (developed on Node 24).

```bash
cd webrtc-SDK
npm install
npm run build              # tsc -b: every package → packages/*/dist (ESM + .d.ts + source maps)
npm test                   # unit tests (jsdom) against the built packages
npm run test:integration   # builds, then runs integration/ against webrtc-BE in-process
```

`test:integration` runs from `../webrtc-BE` with that project's vitest and test setup (in-memory
MongoDB replica set, Clerk test double, the real mediasoup worker for calls). It needs
`webrtc-BE` dependencies installed (`npm install` there). Nothing is mocked on the SpreeWe side;
the only stand-ins are browser APIs Node doesn't have (mediasoup-client's FakeHandler for WebRTC
and a MediaStream shim in `integration/calls.test.ts`).

Example builds: `cd examples/chat-only && npx vite build` (same for `calls-only`, `combined`).

## Layout

```
packages/<name>/src         source (TypeScript, Lit, no decorators)
packages/<name>/test        unit tests
packages/<name>/dist        build output (published)
integration/                tests against the real backend
examples/                   runnable example apps (Vite) and a token-server
docs/                       guides
```

TypeScript project references (`packages/tsconfig.json`) build packages in dependency order.

## Versioning

- [Semantic versioning](https://semver.org). All `@spreewe/*` packages share one version and are
  released together (they're tested together). Feature packages declare `@spreewe/core` and
  `@spreewe/ui` as **peer** dependencies so an app has exactly one copy.
- While on `0.x`, minor versions may contain breaking changes; they're listed in `CHANGELOG.md`.
- Public API = what each package's `index.ts` exports, element tag names, attributes, events, slots,
  CSS parts, `--sw-*` tokens and string keys. Anything else (private `--_*` aliases, internal
  members) may change in any release.
- Bump: `npm version <x.y.z> --workspaces --no-git-tag-version`, then update the peer ranges.

## Publishing

Decisions needed before the first publish (owner: whoever owns the SpreeWe product):

1. **Registry and scope.** The packages are named `@spreewe/*` with `publishConfig.access: restricted`.
   Publishing under that scope requires owning the `spreewe` npm organisation (paid plan for private
   packages), or switching to a private registry (GitHub Packages, Verdaccio, Artifactory).
2. **Licence.** `package.json` says `UNLICENSED` (no rights granted). Third-party developers need a
   licence to use the packages; legal should decide which.

Then:

```bash
npm run build && npm test && npm run test:integration
npm run pack:all                      # tarballs in artifacts/ for a final check
npm publish -w packages/core -w packages/ui -w packages/e2ee …   # every packages/* workspace (examples are private)
```
