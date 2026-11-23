# @spreewe/files

Files shared in SpreeWe chats: the user's file library and one conversation's shared media. Files are
decrypted on the user's device. This package is a headless service plus two Web Components (Lit 3).

## Install

```sh
npm install @spreewe/core @spreewe/ui @spreewe/files
# To open end-to-end encrypted attachments, also install:
npm install @spreewe/e2ee
```

```ts
import "@spreewe/files/define"; // registers <spreewe-file-list> and <spreewe-shared-media>
```

## Scopes

| Scope | Needed for |
| --- | --- |
| `files:read` | `GET /files` and `GET /conversations/:id/media` (required) |
| `e2ee:device` | Opening encrypted attachments. The server sends ciphertext only to apps with this scope, and the client needs `enableE2ee(client)` from `@spreewe/e2ee`. |

This package does not upload. Sending a file is `getChat(client).open(id).sendFile(file)` in
`@spreewe/chat` (scope `files:write`), which encrypts the file before upload.

## How encrypted attachments work

Chat attachments are end-to-end encrypted. The server stores only ciphertext. The file's name,
type, AES-GCM key, IV and SHA-256 live inside the encrypted message (`SecureContent.file`).

- `GET /conversations/:id/media` returns the message ciphertext (`e2ee`). The service decrypts it
  with the client's `E2eeEngine` to get the name, type and key.
- `GET /files` doesn't include the ciphertext. For encrypted items, the service reads the ciphertext
  from the conversation's media list, with one request per conversation, cached until `refresh()`. That
  list covers the latest 300 media items of a conversation. Older encrypted files get the state
  `"unavailable"`.
- `download(item)` fetches the ciphertext from its signed link, checks the SHA-256 and decrypts it on
  the device. If a signed link has expired, it gets fresh links once and retries.
- Older plaintext attachments use their signed links as they are.

Each `FileItem` has a `state`, which you can show to the user:

| State | Meaning |
| --- | --- |
| `ok` | The name and type are known and the file can be downloaded |
| `pending` | Decrypting, or waiting for the message key. It retries when keys arrive. |
| `locked` | There is no encryption device on this client, or it isn't ready |
| `withheld` | The app lacks `e2ee:device`, so the server doesn't share the ciphertext |
| `unavailable` | The encrypted message couldn't be found (see above), or its lookup failed |
| `failed` | This device can't decrypt the message |

## Service

```ts
import { getFiles } from "@spreewe/files";

const files = getFiles(client);       // one instance per client
const library = files.library("all"); // or "image" | "video" | "audio" | "pdf" | "file" (filtered on the server)
await library.load();
library.state.subscribe((s) => render(s.items));
const blob = await files.download(s.items[0]); // decrypted bytes
```

| Member | Description |
| --- | --- |
| `library(kind?)` | Returns a `FileCollection` for `GET /files`: newest first, 30 per page, with a `before` cursor. There is one collection per kind. |
| `conversation(id)` | Returns a `FileCollection` for `GET /conversations/:id/media`: one response holding at most 300 items. |
| `download(item, { signal? })` | Resolves a `Blob`, decrypted for encrypted items. Throws `SpreeWeError` with code `E2EE_UNAVAILABLE`, `E2EE_FAILED`, `MEDIA_ERROR` or `NETWORK_ERROR`. |
| `save(item, filename?)` | Browser only. Downloads the file and starts a file download. The temporary object URL is revoked after 60 s. |
| `preview(item)` | Resolves an image URL for a thumbnail: the signed link for plaintext images, or a decrypted `blob:` URL for encrypted ones. It keeps at most 120 URLs and at most 3 downloads at once. Resolves `null` for anything else. |
| `releasePreviews()` | Revokes every preview object URL. |
| `latest(item)` | Returns the newest decrypted copy of an item from any loaded collection. |
| `destroy()` | Revokes every object URL and stops listening. `client.destroy()` calls it. |

`FileCollection` has `state` (`{ items, loading, loadingMore, loaded, hasMore, error }`),
`load({ refresh? })`, `refresh()` and `loadMore()`. `loadMore()` applies to `GET /files` only.

The service never connects the socket. If another module connected it and the token has
`messages:read`, a new attachment (`receiveMessage`) refreshes loaded collections and a deleted
message (`message:deleted`) removes its item.

## `<spreewe-file-list>`

The user's files, with server-side kind tabs and a name filter over the loaded items. The server
can't search encrypted file names, so the filter only covers what is loaded.

| | |
| --- | --- |
| Attributes | `kind="all"\|"image"\|"video"\|"audio"\|"pdf"\|"file"`, `no-tabs`, `no-search`, `no-header` |
| Methods | `refresh()` |
| Events | `spreewe-file-select { item }`, `spreewe-file-download { item }` (cancelable; call `preventDefault()` to handle the download yourself), `spreewe-file-kind-change { kind }`, `spreewe-error { error, action, item }` |
| Slots | `header`, `empty` |
| CSS parts | `toolbar`, `title`, `search`, `tabs`, `tab`, `tab-selected`, `list`, `item`, `thumb`, `name`, `meta`, `state`, `download`, `load-more`, `error` |

## `<spreewe-shared-media>`

One conversation's shared items in three tabs. "Photos & videos" is a grid in which encrypted images
are decrypted on the device for thumbnails. "Documents" and "Audio" are lists.

| | |
| --- | --- |
| Attributes | `conversation-id` (required), `tab="media"\|"docs"\|"audio"`, `no-tabs` (one list of everything), `no-header` |
| Methods | `refresh()` |
| Events | `spreewe-file-select { item }`, `spreewe-file-download { item }` (cancelable), `spreewe-media-tab-change { tab }`, `spreewe-error { error, action, item }` |
| Slots | `header`, `empty` |
| CSS parts | `toolbar`, `title`, `tabs`, `tab`, `tab-selected`, `grid`, `tile`, `thumb`, `list`, `item`, `name`, `meta`, `state`, `download`, `notice`, `error` |
| CSS properties | `--sw-media-tile-size` (minimum tile width, 96px) |

Both components show loading and empty states. A 403 shows a message that names the missing scope,
and network errors offer a retry. Arrow keys move through rows and tabs. Every string has a
`files.*` key that you can override with `setStrings()` from `@spreewe/ui`.

## Example

```html
<spreewe-provider id="sw">
  <spreewe-shared-media conversation-id="6710aa000000000000000001"></spreewe-shared-media>
</spreewe-provider>
<script type="module">
  import { enableE2ee } from "@spreewe/e2ee";
  import "@spreewe/files/define";
  enableE2ee(client); // without this, encrypted items show as locked
  document.getElementById("sw").client = client;
  document.addEventListener("spreewe-file-select", (e) => openViewer(e.detail.item));
</script>
```
