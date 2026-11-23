# @spreewe/ui

Foundation for the SpreeWe components: theme tokens, `<spreewe-provider>`, `<spreewe-avatar>`, the
`SpreeWeElement` base class, icons, strings and formatting. Feature packages depend on it; you use it
directly for theming and for your own components.

```bash
npm install @spreewe/ui @spreewe/core lit
```

```ts
import "@spreewe/ui/define";             // <spreewe-provider>, <spreewe-avatar>
import { applyTheme, setStrings, themes } from "@spreewe/ui";
```

Full theming guide: [docs/theming.md](../../docs/theming.md).

## `<spreewe-provider>`

Gives every SpreeWe component inside it a client; renders nothing itself (`display: contents`).

| Property / attribute | |
|---|---|
| `client` (property) | `SpreeWeClient` |
| `theme` | `light` \| `dark` \| `auto` \| `inherit` (default) — sets `color-scheme` for its subtree |
| `themeTokens` (property) | A `Theme` object applied as `--sw-*` custom properties |

Components resolve their client from their own `client` property, else the nearest provider (also
across shadow roots, and when the provider upgrades later), else `setDefaultClient(client)`.

## `<spreewe-avatar>`

Attributes: `name`, `src` (storage key or URL), `size` (px), `presence` (`online|busy|away|offline`),
`shape` (`circle|square`). Parts: `face`, `image`, `initials`, `presence`. Tokens:
`--sw-avatar-size`, `--sw-avatar-radius`, `--sw-avatar-ring`.

## Exports

| | |
|---|---|
| `SpreeWeElement` | Base class: `sw` (client), `clientChanged(client, prev)`, `observe(store, cb)`, `watch/unwatch`, `untilClientChanges(off)`, `fire(name, detail, { cancelable })` |
| `defineElement(tag, ctor)`, `setDefaultClient`, `getDefaultClient` | |
| `TOKENS`, `token(name)`, `baseStyles`, `buttonStyles`, `inputStyles`, `scrollStyles`, `stateStyles` | Shared styles |
| `applyTheme`, `themeToCssVariables`, `cssForTheme`, `themes`, `Theme` | |
| `icon(name, size)`, `setIcon(name, paths)` | |
| `t`, `setStrings`, `registerStrings`, `allStrings`, `setLocale`, `getLocale`, `onStringsChanged` | |
| `initials`, `formatTime`, `formatDay`, `formatListTime`, `formatDateTime`, `formatDuration`, `formatBytes`, `presenceKind`, `presenceLabel` | |
