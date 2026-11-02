import { describe, expect, it } from "vitest";
import { analyzeBucketPolicy, analyzePublicAccessBlock } from "../src/config/check-s3";

/** Phase 5C: the bucket exposure check must catch the policy that caused the incident. */
const doc = (Resource: string | string[], extra: Record<string, unknown> = {}) => ({
    Version: "2012-10-17",
    Statement: [{ Sid: "S", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource, ...extra }],
});
const fails = (f: { level: string }[]) => f.some((x) => x.level === "FAIL");

describe("bucket policy analysis", () => {
    it("FAILS the incident policy (public read on the whole bucket)", () => {
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/*")))).toBe(true);
        expect(fails(analyzeBucketPolicy(JSON.stringify(doc("arn:aws:s3:::b/*"))))).toBe(true);
    });

    it("passes the remediated avatar-only policy", () => {
        const ok = doc(["arn:aws:s3:::b/dev/users/*/avatar/*", "arn:aws:s3:::b/dev/groups/*/avatar/*", "arn:aws:s3:::b/users/*/avatar/*"]);
        expect(fails(analyzeBucketPolicy(ok))).toBe(false);
    });

    it("fails public access to recordings, conversations, a prefix wildcard, or write actions", () => {
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/dev/recordings/*")))).toBe(true);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/dev/conversations/*")))).toBe(true);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/dev/*")))).toBe(true);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/*/avatar/*")))).toBe(true);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/dev/users/*/avatar/*", { Action: ["s3:GetObject", "s3:PutObject"] })))).toBe(true);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/dev/users/*/avatar/*", { Principal: { AWS: "*" }, Action: "s3:*" })))).toBe(false); // read-equivalent wildcard on avatars only
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/x", { NotResource: "arn:aws:s3:::b/private/*" })))).toBe(true);
    });

    it("ignores non-public and Deny statements; no policy is fine", () => {
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/*", { Principal: { AWS: "arn:aws:iam::1:user/app" } })))).toBe(false);
        expect(fails(analyzeBucketPolicy(doc("arn:aws:s3:::b/*", { Effect: "Deny" })))).toBe(false);
        expect(fails(analyzeBucketPolicy(null))).toBe(false);
    });

    it("public ACLs must be blocked and ignored", () => {
        expect(fails(analyzePublicAccessBlock({ BlockPublicAcls: true, IgnorePublicAcls: true }))).toBe(false);
        expect(fails(analyzePublicAccessBlock({ BlockPublicAcls: false, IgnorePublicAcls: false }))).toBe(true);
    });
});
