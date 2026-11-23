# Theming and customisation

The components ship with SpreeWe's design language (slate palette, rounded bubbles, dark call
stage) but take their font from your page and every visual value from CSS custom properties, so
they can look like your app instead.

Five levels, from least to most effort:

1. **Light / dark** — follow your page's `color-scheme`.
2. **Tokens** — override `--sw-*` custom properties (colours, font, sizes, radii, spacing).
3. **CSS parts** — style specific inner elements with `::part()`.
4. **Slots, attributes, events** — replace headers and empty states, hide features, react to actions.
5. **Headless** — use the services and build your own components.

## 1. Light and dark

Colour defaults use CSS `light-dark()`, so components follow the `color-scheme` of the page:

```css
:root { color-scheme: light dark; }   /* follow the OS */
:root { color-scheme: dark; }         /* always dark */
```

or per subtree with `<spreewe-provider theme="light | dark | auto | inherit">` (default `inherit`).
The call stage is dark in both schemes unless you override the `--sw-call-*` tokens.

## 2. Tokens

Custom properties inherit through shadow DOM, so set them on `:root`, `body`, a wrapper, or
`<spreewe-provider>`:

```css
.support-panel {
  --sw-font-family: "Inter", sans-serif;     /* default: inherit (your page's font) */
  --sw-color-brand: light-dark(#5b3cc4, #b7a6f5);
  --sw-bubble-out: light-dark(#5b3cc4, #4a3a8c);
  --sw-radius: 4px;
  --sw-bubble-radius: 6px;
}
```

From JavaScript: `applyTheme(element, theme)` (returns a function that removes it),
`cssForTheme(".selector", theme)` (stylesheet text), `provider.themeTokens = theme`. Built-ins:
`themes.spreewe` (defaults), `themes.neutral`, `themes.compact`; extend with
`{ ...themes.neutral, brand: "#0a66c2" }`.

| Token | Default (light / dark) | Used for |
|---|---|---|
| `--sw-color-brand` | `#2c3a47` / `#a9bcc8` | Primary buttons, selection, badges |
| `--sw-color-brand-strong` | `#19222b` / `#c3d1d9` | Primary hover |
| `--sw-color-brand-soft` | `#e4eaed` / `#26323d` | Chips, role tags |
| `--sw-color-on-brand` | `#fff` / `#121920` | Text on brand fills |
| `--sw-color-accent` | `#3f7fb4` / `#82b4dc` | Accents |
| `--sw-color-bg`, `--sw-color-surface`, `--sw-color-surface-2` | slate / dark slate | Backgrounds |
| `--sw-color-input`, `--sw-color-hover`, `--sw-color-active`, `--sw-color-border`, `--sw-color-overlay` | | Inputs, states, borders |
| `--sw-color-text`, `--sw-color-text-2`, `--sw-color-muted` | | Text |
| `--sw-color-success`, `--sw-color-danger`, `--sw-color-warning`, `--sw-color-read`, `--sw-color-highlight` | | Status |
| `--sw-color-presence-online / busy / away / offline` | | Presence dots |
| `--sw-chat-bg`, `--sw-bubble-in`, `--sw-bubble-in-text`, `--sw-bubble-in-border`, `--sw-bubble-out`, `--sw-bubble-out-text`, `--sw-bubble-out-border` | | Messages |
| `--sw-call-bg`, `--sw-call-surface`, `--sw-call-tile`, `--sw-call-control`, `--sw-call-control-hover`, `--sw-call-text`, `--sw-call-muted`, `--sw-call-danger` | dark | Call stage |
| `--sw-font-family` | `inherit` | All text |
| `--sw-font-size`, `--sw-font-size-sm`, `--sw-font-size-lg`, `--sw-font-size-xl` | 14 / 12 / 16 / 20px | |
| `--sw-font-weight-medium`, `--sw-font-weight-bold`, `--sw-line-height` | 500 / 600 / 1.45 | |
| `--sw-radius-sm`, `--sw-radius`, `--sw-radius-lg`, `--sw-radius-pill`, `--sw-bubble-radius` | 6 / 10 / 14 / 999 / 14px | |
| `--sw-space-1` … `--sw-space-6` | 4 / 8 / 12 / 16 / 24 / 32px | Padding and gaps |
| `--sw-avatar-size`, `--sw-control-height`, `--sw-border-width` | 36 / 36 / 1px | |
| `--sw-shadow-sm`, `--sw-shadow`, `--sw-focus-ring`, `--sw-transition` | | |

The full list with exact values is `TOKENS` in `@spreewe/ui`. Some components add their own
(documented in their README), e.g. `--sw-chat-list-width`, `--sw-chat-split`, `--sw-call-radius`,
`--sw-incoming-z`.

To support browsers without `light-dark()`, set every colour token to a plain value (for example in
a `@media (prefers-color-scheme: dark)` block).

## 3. CSS parts

Each component lists its parts in its README. Example:

```css
spreewe-message-list::part(bubble-mine) { box-shadow: none; }
spreewe-conversation-list::part(item-selected) { border-left-color: hotpink; }
spreewe-call-controls::part(leave) { border-radius: 8px; }
```

Parts don't reach through nested components (a part inside `<spreewe-message-list>` inside
`<spreewe-chat-window>`): style the inner component directly or use tokens.

## 4. Slots, attributes and events

- **Slots** replace or extend regions: `<spreewe-chat-window>` has `header`, `header-actions`, `empty`,
  `composer-before`, `composer-after`; lists have `header`, `empty`, `footer`.
- **Attributes** turn features off: `no-search`, `no-attachments`, `no-emoji`, `readonly`, `no-screen` …
- **Events** are `spreewe-*`, bubbling and composed. Some are cancelable so you can substitute your own
  UI: `spreewe-delete-request` and `spreewe-confirm-request` (use your dialog instead of the browser's
  `confirm()`), `spreewe-incoming-call` (your own ringing UI), `spreewe-notification-select`.
- **Layout:** the components fill their container (`height: 100%`) and adapt with container queries.
  `<spreewe-chat>` is a convenience; for your own layout place `<spreewe-conversation-list>` and
  `<spreewe-chat-window>` wherever you want.

## 5. Strings and locale

Every visible string has a key with an English default.

```ts
import { setStrings, setLocale, allStrings } from "@spreewe/ui";
setLocale("de");                                     // dates, times and numbers (Intl)
setStrings({ "chat.composer.placeholder": "Nachricht schreiben…", "chat.window.typing.one": "{name} schreibt…" });
console.log(allStrings());                           // every key, for a translation file
```

Call these before the components render (or re-render them). Keys are prefixed by module
(`chat.`, `calls.`, `groups.`, …).

## 6. Icons

`setIcon(name, paths)` replaces an icon (24×24 stroke path data) everywhere, e.g. to match your icon set.

## 7. Headless

Every component is a thin view over a service: `getChat(client)`, `getGroups(client)`,
`getCalls(client)`, … Services expose stores (`subscribe(listener)` returning an unsubscribe
function, plus `.value`) and methods. Build your own UI in any framework on top of them; see each
module's README for the service API.

## Your own components

Extend `SpreeWeElement` from `@spreewe/ui` to get client resolution (`this.sw`), `clientChanged()`,
`observe(store)` and `fire(event)`, and reuse the shared styles (`baseStyles`, `buttonStyles`, …):

```ts
import { html } from "lit";
import { SpreeWeElement, baseStyles, defineElement } from "@spreewe/ui";
import { getChat } from "@spreewe/chat";

class UnreadPill extends SpreeWeElement {
  static styles = [baseStyles];
  protected clientChanged(client) { if (client) this.observe(getChat(client).conversations); }
  render() { return html`${this.sw ? getChat(this.sw).unreadTotal : 0} unread`; }
}
defineElement("acme-unread-pill", UnreadPill);
```
