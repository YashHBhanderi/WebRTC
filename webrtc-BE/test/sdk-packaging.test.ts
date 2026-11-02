import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * @spreewe/chat-sdk is an ES-module package ("type": "module"). Bundlers that follow the ESM spec
 * strictly (webpack 5 by default) require fully specified relative imports ('./client.js', not
 * './client'). An extension-less import breaks webpack 5 builds of apps using the SDK.
 */
describe("SDK packaging: fully specified ES-module imports", () => {
    const src = path.resolve(__dirname, "../../packages/chat-sdk/src");

    it("the package is an ES module", () => {
        expect(JSON.parse(fs.readFileSync(path.resolve(src, "../package.json"), "utf8")).type).toBe("module");
    });

    it("every relative import / export in the SDK source ends with .js", () => {
        const bad: string[] = [];
        for (const file of fs.readdirSync(src).filter((f) => f.endsWith(".ts"))) {
            const text = fs.readFileSync(path.join(src, file), "utf8");
            for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
                if (!m[1].endsWith(".js")) bad.push(`${file}: ${m[1]}`);
            }
            for (const m of text.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
                if (!m[1].endsWith(".js")) bad.push(`${file}: import(${m[1]})`);
            }
        }
        expect(bad).toEqual([]);
    });
});
