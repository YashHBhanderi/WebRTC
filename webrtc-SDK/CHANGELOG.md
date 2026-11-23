# Changelog

All `@spreewe/*` packages share one version. Format: [Keep a Changelog](https://keepachangelog.com); versions follow semver (0.x: minor versions may break).

## 0.1.0 — unreleased

First version.

- `@spreewe/core`: client, OAuth 2.0 + PKCE client with rotating refresh tokens, backend token exchange and session token providers, REST client (envelopes, 401/429 retry, errors), Socket.IO manager (fresh token per handshake, server-close recovery, room re-join, ack timeouts), people/presence, shared types, scope catalogue.
- `@spreewe/ui`: design tokens with light/dark, `<spreewe-provider>`, `<spreewe-avatar>`, `SpreeWeElement`, icons, strings and locale.
- `@spreewe/e2ee`: Olm/Megolm encryption device (IndexedDB or memory), encrypted attachments.
- `@spreewe/chat`, `@spreewe/groups`, `@spreewe/calls`, `@spreewe/meetings`, `@spreewe/files`, `@spreewe/notifications`, `@spreewe/contacts`: headless services and Web Components.
- Integration tests against the real backend; unit tests in jsdom; three examples.
- `@spreewe/core/server`: server-side client for your backend (separate entry point, never in the browser bundle): register, read, list, update, deactivate and reactivate your app's users (`/v1/app-users`), exchange the app credential for user tokens with caching, revoke tokens.
