# Installation

## Packages

Install `@spreewe/core`, `@spreewe/ui` and the feature modules you use. Each module lists its peer
dependencies; npm 7+ installs them automatically, but listing them in your own `package.json` keeps
versions explicit.

| You integrate | Install |
|---|---|
| Chat (read and send) | `@spreewe/core @spreewe/ui @spreewe/chat @spreewe/e2ee @matrix-org/matrix-sdk-crypto-wasm@18.9.0` |
| Chat (read-only, no message content) | `@spreewe/core @spreewe/ui @spreewe/chat` |
| Calls | `@spreewe/core @spreewe/ui @spreewe/calls mediasoup-client` |
| Groups | `@spreewe/core @spreewe/ui @spreewe/groups` |
| Meetings | `@spreewe/core @spreewe/ui @spreewe/meetings` |
| Files | `@spreewe/core @spreewe/ui @spreewe/files` (+ `@spreewe/e2ee` to open encrypted attachments) |
| Notifications | `@spreewe/core @spreewe/ui @spreewe/notifications` |
| Contacts | `@spreewe/core @spreewe/ui @spreewe/contacts` |
| No UI (services only) | `@spreewe/core` + the module packages; ignore their `/define` entries |

Version constraints:

- `@matrix-org/matrix-sdk-crypto-wasm` must be **18.9.x**, the version the SpreeWe backend and
  apps are tested with. Major 19 hasn't been checked.
- `mediasoup-client` `^3.23.0` (tested with 3.26.0).
- `lit` `^3.3`, `socket.io-client` `^4.8`.

> **Registry.** The packages are not on a public registry yet. Until they are, install from tarballs
> (`npm run pack:all` in `webrtc-SDK` writes them to `artifacts/`) or from your private registry.
> See [development.md](development.md#publishing).

## Two entry points per UI package

```ts
import { getChat, SpreeWeChatWindow } from "@spreewe/chat"; // classes and services, no side effects
import "@spreewe/chat/define"; // registers <spreewe-*> tags (and <spreewe-provider>, <spreewe-avatar>)
```

- Import `/define` once, anywhere in your app, to use the default tag names.
- To use your own tag names (to avoid a clash, or to subclass), skip `/define` and call
  `customElements.define("acme-chat-window", SpreeWeChatWindow)`. Internal children use the default
  tags, so also import `@spreewe/ui/define` and register the module's other elements.
- The packages are ES modules with `sideEffects` declared, so bundlers drop what you don't import.

## Bundlers

Tested with **Vite 6**. Any bundler that handles ES modules and `new URL("...", import.meta.url)`
assets works (webpack 5, Rollup, esbuild with an asset plugin, Parcel 2).

### End-to-end encryption WASM

`@matrix-org/matrix-sdk-crypto-wasm` loads `matrix_sdk_crypto_wasm_bg.wasm` (about 7.8 MB, 2.1 MB
gzipped) the first time encryption starts. It is not in your main bundle.

- **Vite:** exclude it from dependency pre-bundling, or the dev server can't find the `.wasm`:
  ```ts
  // vite.config.ts
  export default defineConfig({ optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm"] } });
  ```
- **Serving it yourself** (CDN, strict CSP): copy the file from
  `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/` and pass its URL:
  `enableE2ee(client, { wasmUrl: "/static/matrix_sdk_crypto_wasm_bg.wasm" })`.
- Serve `.wasm` as `application/wasm`. Your CSP must allow `'wasm-unsafe-eval'` in `script-src`.

### mediasoup-client

Loaded with a dynamic `import()` on the first call, so it lands in its own chunk (about 41 KB gzipped).

## Browser support

The packages target ES2022 and use Web Components, Shadow DOM, `light-dark()`, `color-mix()` and
container queries. That means:

- Chrome / Edge 123+, Firefox 120+, Safari 17.5+.
- Encryption also needs IndexedDB, WebCrypto (secure context: https or localhost) and WebAssembly.
  Without them the encryption device reports `unsupported` and chat stays read-only.
- Calls need WebRTC and, for screen sharing, `getDisplayMedia` (not on most mobile browsers).

Older browsers aren't supported. `light-dark()` has no polyfill; to support them, set every colour
token to a plain value (see [theming.md](theming.md)).

## Without a bundler

There is no prebuilt CDN bundle yet. For prototypes you can use an import map pointing at a CDN that
serves npm packages as ES modules (lit, socket.io-client and the @spreewe packages). For production,
use a bundler.
