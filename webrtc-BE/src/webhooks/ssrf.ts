import dns from "dns";
import net from "net";

/**
 * SSRF policy for outbound webhooks.
 *
 *   - Destination URL (config time and again at delivery): https only for production apps; http is
 *     allowed only for development apps. Ports: 443 / 8443 (https), 80 / 8080 (http, development
 *     only). No userinfo, no fragments. The hostname is taken AFTER WHATWG URL normalisation, so
 *     decimal / octal / hex IPv4 forms ("2130706433", "0x7f.1") become dotted quads and are checked.
 *   - Every address the hostname resolves to must be public (blocklist below). IP-literal hosts are
 *     checked directly.
 *   - At delivery the HTTP client connects through pinnedLookup(): the resolution that is validated
 *     is the one used for the connection (no DNS-rebinding window). Redirects are never followed.
 *     Proxy environment variables are not used.
 */
const BLOCKED_V4: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const BLOCKED_V6: [string, number][] = [
    ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32],
    ["100::", 64], ["2001::", 23],
];

const blockList = new net.BlockList();
BLOCKED_V4.forEach(([a, p]) => blockList.addSubnet(a, p, "ipv4"));
BLOCKED_V6.forEach(([a, p]) => blockList.addSubnet(a, p, "ipv6"));

/** IPv4 embedded in IPv6 forms that route to IPv4: ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96 (NAT64), 2002::/16 (6to4). */
function embeddedV4(v6: string): string | null {
    const lower = v6.toLowerCase();
    const dotted = /(?:^::ffff:|^::|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted) return dotted[1];
    const words = expandV6(lower);
    if (!words) return null;
    const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    // ::ffff:hhhh:hhhh and ::hhhh:hhhh (deprecated compatible), 64:ff9b::hhhh:hhhh
    if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) return toV4(words[6], words[7]);
    if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return toV4(words[6], words[7]);
    if (words[0] === 0x2002) return toV4(words[1], words[2]);
    return null;
}

function expandV6(v6: string): number[] | null {
    if (!net.isIPv6(v6) || v6.includes(".")) return null;
    const [head, tail] = v6.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
    const fill = tail !== undefined ? 8 - h.length - t.length : 0;
    const all = [...h, ...Array(fill).fill("0"), ...t];
    return all.length === 8 ? all.map((x) => parseInt(x, 16)) : null;
}

export function isPublicAddress(address: string): boolean {
    const clean = address.replace(/^\[|\]$/g, "").split("%")[0];
    if (net.isIPv4(clean)) return !blockList.check(clean, "ipv4");
    if (net.isIPv6(clean)) {
        const v4 = embeddedV4(clean);
        if (v4) return net.isIPv4(v4) && !blockList.check(v4, "ipv4");
        return !blockList.check(clean, "ipv6");
    }
    return false;
}

export class BlockedDestinationError extends Error {
    constructor(public readonly reason: string) {
        super(`Webhook destination not allowed: ${reason}`);
        this.name = "BlockedDestinationError";
    }
}

export interface ParsedDestination {
    url: URL;
    hostname: string;
    port: number;
    protocol: "https:" | "http:";
}

/** Syntactic policy (no DNS). Throws BlockedDestinationError with a safe reason. */
export function parseDestination(raw: string, environment: "development" | "production"): ParsedDestination {
    if (typeof raw !== "string" || raw.length > 500) throw new BlockedDestinationError("invalid URL");
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new BlockedDestinationError("invalid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedDestinationError("only https is allowed");
    if (url.protocol === "http:" && environment === "production") throw new BlockedDestinationError("production apps must use https");
    if (url.username || url.password) throw new BlockedDestinationError("credentials in the URL are not allowed");
    if (url.hash) throw new BlockedDestinationError("fragments are not allowed");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const allowed = url.protocol === "https:" ? [443, 8443] : [80, 8080];
    if (!allowed.includes(port) && !extraPortsForTests.includes(port)) throw new BlockedDestinationError(`port ${port} is not allowed (use ${allowed.join(" or ")})`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
        throw new BlockedDestinationError("internal host names are not allowed");
    }
    if (net.isIP(hostname) && !isPublicAddress(hostname)) throw new BlockedDestinationError("private or reserved address");
    return { url, hostname, port, protocol: url.protocol as "https:" | "http:" };
}

// ------------------------------------------------------------------ resolution (injectable for tests only)

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });
let resolver: Resolver = systemResolver;
let allowLoopbackForTests = false;
let extraPortsForTests: number[] = [];

/** Tests only (refused outside NODE_ENV=test): fake DNS, permit a loopback receiver on a test port. */
export function setWebhookNetworkForTests(options: { resolver?: Resolver | null; allowLoopback?: boolean; allowPorts?: number[] }): void {
    if (process.env.NODE_ENV !== "test") throw new Error("setWebhookNetworkForTests is only available in tests");
    resolver = options.resolver ?? systemResolver;
    allowLoopbackForTests = !!options.allowLoopback;
    extraPortsForTests = options.allowPorts || [];
}

function acceptable(address: string): boolean {
    if (allowLoopbackForTests && (address === "127.0.0.1" || address === "::1")) return true;
    return isPublicAddress(address);
}

/** Full check: syntax + every resolved address public. Used at configuration time. */
export async function validateDestination(raw: string, environment: "development" | "production"): Promise<ParsedDestination> {
    const dest = parseDestination(raw, environment);
    if (net.isIP(dest.hostname)) {
        if (!acceptable(dest.hostname)) throw new BlockedDestinationError("private or reserved address");
        return dest;
    }
    let addresses: { address: string; family: number }[];
    try {
        addresses = await resolver(dest.hostname);
    } catch {
        throw new BlockedDestinationError("host name does not resolve");
    }
    if (!addresses.length) throw new BlockedDestinationError("host name does not resolve");
    if (addresses.some((a) => !acceptable(a.address))) throw new BlockedDestinationError("host name resolves to a private or reserved address");
    return dest;
}

/**
 * net/http `lookup` replacement: resolves, rejects if ANY address is not public, and returns the
 * validated address(es) — the socket connects to exactly what was checked.
 */
export function pinnedLookup(hostname: string, options: any, callback: (...args: any[]) => void): void {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    const done = (list: { address: string; family: number }[]) => {
        if (opts.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    };
    if (net.isIP(hostname)) {
        return acceptable(hostname) ? done([{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }]) : cb(new BlockedDestinationError("private or reserved address"));
    }
    resolver(hostname).then((list) => {
        if (!list.length) return cb(new BlockedDestinationError("host name does not resolve"));
        if (list.some((a) => !acceptable(a.address))) return cb(new BlockedDestinationError("host name resolves to a private or reserved address"));
        const wanted = opts.family === 4 || opts.family === 6 ? list.filter((a) => a.family === opts.family) : list;
        if (!wanted.length) return cb(new BlockedDestinationError("no usable address"));
        done(wanted);
    }, () => cb(new BlockedDestinationError("host name does not resolve")));
}
