# Using the components with frameworks

The components are standard custom elements. Two rules apply in every framework:

1. **Objects go in properties, not attributes.** `client`, `themeTokens`, `selected` (member picker)
   and media streams are JavaScript properties. Strings and booleans (`conversation-id`, `readonly`)
   can be attributes.
2. **Events are DOM `CustomEvent`s** named `spreewe-*`, with data in `event.detail`.

Create one client per signed-in user and give it to a `<spreewe-provider>` near the root (or call
`setDefaultClient(client)`); every component inside finds it.

## React 19

React 19 sets properties on custom elements and supports `on<event>` for custom events.

```tsx
import "@spreewe/chat/define";
import "@spreewe/calls/define";

export function Support({ client }) {
  const [conversationId, setConversationId] = useState("");
  return (
    <spreewe-provider client={client}>
      <spreewe-conversation-list onspreewe-conversation-select={(e) => setConversationId(e.detail.conversationId)} />
      <spreewe-chat-window conversation-id={conversationId}>
        <spreewe-call-button slot="header-actions" conversation-id={conversationId} call-type="video" />
      </spreewe-chat-window>
    </spreewe-provider>
  );
}
```

TypeScript: declare the tags once (the `HTMLElementTagNameMap` entries come with each `/define` module):

```ts
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "spreewe-provider": any;
      "spreewe-conversation-list": any;
      "spreewe-chat-window": any;
      "spreewe-call-button": any;
    }
  }
}
```

**React 18** sets attributes only and doesn't bind custom events: use a ref.

```tsx
const ref = useRef<HTMLElementTagNameMap["spreewe-provider"]>(null);
useEffect(() => { if (ref.current) ref.current.client = client; }, [client]);
useEffect(() => {
  const list = listRef.current!;
  const on = (e: Event) => setConversationId((e as CustomEvent).detail.conversationId);
  list.addEventListener("spreewe-conversation-select", on);
  return () => list.removeEventListener("spreewe-conversation-select", on);
}, []);
```

## Vue 3

Tell Vue the tags are custom elements (`vite.config.ts`):

```ts
vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("spreewe-") } } })
```

```vue
<spreewe-provider :client="client">
  <spreewe-conversation-list @spreewe-conversation-select="id = $event.detail.conversationId" />
  <spreewe-chat-window :conversation-id="id" />
</spreewe-provider>
```

Vue sets properties when the element has them, so `:client` works.

## Angular

Add `CUSTOM_ELEMENTS_SCHEMA` to the standalone component (or module), and bind properties with `[prop]`:

```ts
@Component({
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <spreewe-provider [client]="client">
      <spreewe-conversation-list (spreewe-conversation-select)="id = $any($event).detail.conversationId"></spreewe-conversation-list>
      <spreewe-chat-window [attr.conversation-id]="id"></spreewe-chat-window>
    </spreewe-provider>`,
})
export class SupportComponent { client = inject(SpreeWeClientToken); id = ""; }
```

Socket and store callbacks run outside Angular's zone only if you subscribe yourself; components
update themselves regardless of change detection.

## Svelte 5

```svelte
<spreewe-provider client={client}>
  <spreewe-chat-window conversation-id={id} onspreewe-back={() => (id = "")}></spreewe-chat-window>
</spreewe-provider>
```

## Headless with any framework

Services expose stores with `subscribe(listener) → unsubscribe` and `.value`:

```ts
// React
function useStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore((cb) => store.subscribe(cb), () => store.value);
}
const { items } = useStore(getChat(client).conversations);
```

## Server-side rendering

The components are client-only (they need the DOM, WebSockets and, for E2EE, IndexedDB). Import the
`/define` modules in client code only (e.g. a dynamic import in `useEffect`, `onMounted`, or Next.js
`"use client"` + `dynamic(..., { ssr: false })`).
