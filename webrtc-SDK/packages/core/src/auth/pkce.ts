/** RFC 7636 PKCE helpers (WebCrypto CSPRNG and SHA-256; never Math.random). */

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function cryptoApi(): Crypto {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (!c?.getRandomValues || !c.subtle) throw new Error("WebCrypto is required (secure context: https or localhost).");
    return c;
}

/** Random string of unreserved characters (rejection sampling keeps the distribution uniform). */
export function randomString(length: number): string {
    const c = cryptoApi();
    const out: string[] = [];
    const limit = 256 - (256 % UNRESERVED.length);
    while (out.length < length) {
        for (const b of c.getRandomValues(new Uint8Array(length * 2))) {
            if (b < limit) out.push(UNRESERVED[b % UNRESERVED.length]);
            if (out.length === length) break;
        }
    }
    return out.join("");
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const b of arr) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function codeChallengeS256(verifier: string): Promise<string> {
    const digest = await cryptoApi().subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64Url(digest);
}

/** A verifier of 64 characters (RFC 7636 allows 43–128) and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
    const verifier = randomString(64);
    return { verifier, challenge: await codeChallengeS256(verifier) };
}
