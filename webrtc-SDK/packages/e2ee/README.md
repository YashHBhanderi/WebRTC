# @spreewe/e2ee

An end-to-end encryption device for the signed-in user: Olm/Megolm through
`@matrix-org/matrix-sdk-crypto-wasm`, the same protocol and message format as the SpreeWe apps.
With it, `@spreewe/chat` can decrypt and send, and `@spreewe/files` can open encrypted attachments.

```bash
npm install @spreewe/e2ee @matrix-org/matrix-sdk-crypto-wasm@18.9.0
```

```ts
import { enableE2ee } from "@spreewe/e2ee";
const device = enableE2ee(client);       // registers on the client; chat starts it on first use
await device.start();                    // optional: start early
device.status.subscribe((s) => …);       // idle | starting | ready | unsupported | revoked | error
```

**Scope:** `e2ee:device` (plus `messages:read` to read, `messages:write` / `messages:edit` to send and
edit). The device shows in the user's device list as "<app name> (app)"; the user can revoke it.
Without the scope `start()` rejects with `MISSING_SCOPE` and chat stays read-only.

## Options

| Option | Default | |
|---|---|---|
| `storage` | `"indexeddb"` in browsers, `"memory"` elsewhere | Memory = a new device every start (tests, bots) |
| `namespace` | `"spreewe-e2ee"` | IndexedDB name prefix; use one per app on a shared origin |
| `wasmUrl` | next to the library module | Where `matrix_sdk_crypto_wasm_bg.wasm` is served |
| `displayName` | — | Ignored for developer apps (the server names the device) |
| `syncIntervalMs` | 60 000 | Safety-net sync; `e2ee:to-device` triggers immediate syncs |
| `deviceListMaxAgeMs` | 30 000 | Re-query members' devices before a message at most this often per room (0 = every message) |
| `loadSdk` | `import()` of the package | Custom loader |

## What it does

- Keys are created on the device and stored in IndexedDB, encrypted with a random passphrase
  that's wrapped by a non-extractable AES-GCM key. The server only receives public keys and ciphertext.
- Room keys go to the devices of the conversation's current members **as listed by the server**
  (`/v1/e2ee/rooms/:id/members`); when someone leaves, the session is rotated before the next message.
- Decryption checks that the sending device key belongs to the claimed sender; otherwise the
  message isn't shown. Unverified devices give a warning, not a failure.
- No plaintext fallback: `encrypt()` throws.
- One browser tab holds the device (Web Lock); others report an error instead of corrupting it.
- A revoked device is replaced by a new one on the next start. **No key backup**: a new device can't
  read messages sent before it existed.

## `E2eeDevice`

`start()`, `stop()`, `status`, `statusMessage`, `deviceId`, `encrypt(conversationId, content)`,
`decrypt(message)`, `onKeysChanged(fn)`, `encryptFile(blob)`, `decryptFile(ciphertext, info)`,
`sync()`, `devices()`, `revokeDevice(id)`, `contactDevices(userId)`, `setDeviceVerified(userId, deviceId, verified)`,
`ownFingerprint()`. Also exported: `encryptFile` / `decryptFile` (AES-256-GCM attachment helpers),
`fingerprint`, `matrixUser`, `matrixRoom`.
