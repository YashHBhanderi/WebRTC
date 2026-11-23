import type { Unsubscribe } from "@spreewe/core";

/** Components that found no <spreewe-provider> when they connected (a provider may upgrade later). */
const orphans = new Set<{ el: HTMLElement; retry: () => void }>();

export function registerOrphan(el: HTMLElement, retry: () => void): Unsubscribe {
    const entry = { el, retry };
    orphans.add(entry);
    return () => orphans.delete(entry);
}

/** Let the orphans inside `provider` (across shadow roots) ask again. */
export function adoptOrphans(provider: Node): void {
    for (const o of [...orphans]) if (o.el !== provider && composedContains(provider, o.el)) o.retry();
}

function composedContains(ancestor: Node, node: Node): boolean {
    let n: Node | null = node;
    while (n) {
        if (n === ancestor) return true;
        n = n.parentNode || (n as ShadowRoot).host || null;
    }
    return false;
}
