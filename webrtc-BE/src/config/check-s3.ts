import dotenv from "dotenv";
dotenv.config();

import { GetBucketPolicyCommand, GetPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Bucket exposure check (Phase 5C, after the public-bucket incident). Private data — chat attachments,
 * recordings, transcripts — must never be readable anonymously; only avatar folders may be public.
 *
 *   npm run check:s3     read-only (GetBucketPolicy, GetPublicAccessBlock); prints findings, never keys
 *                        or credentials; exit code 1 on any FAIL.
 */
export interface S3Finding {
    level: "PASS" | "WARN" | "FAIL";
    detail: string;
}

/** Resources a public statement may cover: avatar folders under any key prefix. */
const AVATAR_RESOURCE = /^arn:aws:s3:::[^/]+\/(?:[^*/]+\/)?(?:users|groups)\/\*\/avatar\/\*$/;
const READ_ACTIONS = /^(s3:\*|\*|s3:Get\*|s3:GetObject\*?|s3:GetObjectVersion)$/i;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function isPublicPrincipal(principal: unknown): boolean {
    if (principal === "*") return true;
    const aws = (principal as { AWS?: unknown })?.AWS;
    return asArray(aws as string | string[]).some((p) => p === "*");
}

/** Analyse a bucket policy document (JSON string or object). */
export function analyzeBucketPolicy(policy: string | Record<string, unknown> | null): S3Finding[] {
    if (!policy) return [{ level: "PASS", detail: "no bucket policy (nothing is public through a policy)" }];
    const doc = typeof policy === "string" ? JSON.parse(policy) : policy;
    const findings: S3Finding[] = [];
    for (const st of asArray<any>(doc.Statement)) {
        if (st.Effect !== "Allow" || !isPublicPrincipal(st.Principal)) continue;
        const actions = asArray<string>(st.Action);
        if (st.NotAction || st.NotResource) {
            findings.push({ level: "FAIL", detail: `public statement ${st.Sid || "(no Sid)"} uses NotAction / NotResource` });
            continue;
        }
        const nonRead = actions.filter((a) => !READ_ACTIONS.test(a));
        if (nonRead.length) findings.push({ level: "FAIL", detail: `public statement ${st.Sid || "(no Sid)"} allows ${nonRead.join(", ")}` });
        const broad = asArray<string>(st.Resource).filter((r) => !AVATAR_RESOURCE.test(r));
        if (broad.length) {
            findings.push({ level: "FAIL", detail: `public read outside avatar folders: ${broad.map((r) => r.replace(/^arn:aws:s3:::[^/]+/, "<bucket>")).join(", ")}` });
        }
        if (!broad.length && !nonRead.length) findings.push({ level: "PASS", detail: `public statement ${st.Sid || "(no Sid)"} covers avatar folders only` });
    }
    return findings.length ? findings : [{ level: "PASS", detail: "no public statements" }];
}

export function analyzePublicAccessBlock(pab: { BlockPublicAcls?: boolean; IgnorePublicAcls?: boolean } | null): S3Finding[] {
    if (!pab) return [{ level: "WARN", detail: "no Public Access Block configuration (public ACLs would be honoured)" }];
    return pab.BlockPublicAcls && pab.IgnorePublicAcls
        ? [{ level: "PASS", detail: "public ACLs blocked and ignored" }]
        : [{ level: "FAIL", detail: "BlockPublicAcls and IgnorePublicAcls must both be true" }];
}

if (require.main === module) {
    (async () => {
        const Bucket = String(process.env.S3_BUCKET || "");
        if (!Bucket) {
            console.log("FAIL  S3_BUCKET is not set");
            process.exitCode = 1;
            return;
        }
        const s3 = new S3Client({ region: process.env.AWS_REGION });
        const policy = await s3.send(new GetBucketPolicyCommand({ Bucket })).then((r) => r.Policy ?? null, (e) => (e?.name === "NoSuchBucketPolicy" ? null : Promise.reject(e)));
        const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket })).then((r) => r.PublicAccessBlockConfiguration ?? null, (e) => (e?.name === "NoSuchPublicAccessBlockConfiguration" ? null : Promise.reject(e)));
        const findings = [...analyzeBucketPolicy(policy), ...analyzePublicAccessBlock(pab)];
        for (const f of findings) console.log(`${f.level.padEnd(4)}  ${f.detail}`);
        process.exitCode = findings.some((f) => f.level === "FAIL") ? 1 : 0;
    })().catch((error) => {
        console.log(`FAIL  could not read the bucket configuration: ${(error as Error)?.name || "error"}`);
        process.exitCode = 1;
    });
}
