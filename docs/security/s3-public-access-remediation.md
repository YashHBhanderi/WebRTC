# S3 public access: incident remediation

Status (2026-10-26): **contained on the only bucket that exists.** Exposure before containment cannot be ruled out (no access logs). Owner action required: see "Required actions".

## Summary

| Item | Value |
|---|---|
| Severity | Critical (confidentiality) |
| Component | S3 bucket `webrtc-test-dev-128d3567472b196e1045d829b3`, account `107258763738`, region `ap-south-1`. The owner confirmed it is the **only** bucket (no separate production bucket exists yet). |
| Root cause | Bucket policy statement `PublicReadGetObject`: `Principal: *`, `s3:GetObject` on `<bucket>/*`. All four Public Access Block settings were off. The application's design needed public reads only for avatars, but the policy granted them for every object. |
| Detected | Phase 5B staging validation (2026-10-22): an unsigned GET of a private attachment and an unsigned HEAD of a recording both returned 200. |
| Contained | 2026-10-26, with the owner's explicit approval of the exact change. |

## Exposure (what was readable by anyone with the URL)

Inventory at containment, current object versions (categories only, no keys):

| Category | Objects | Sensitivity |
|---|---|---|
| `dev/recordings/<conversationId>/<recordingId>.mp4` | 10 | **High.** Meeting audio and video. Keys are two MongoDB ObjectIds, which are partly predictable (timestamp + counter), so they were **guessable**, not just leakable. |
| `dev/conversations/<id>/{images,documents,videos}/<yyyy>/<mm>/<uuid>.<ext>` | 27 | **High.** Chat attachments. UUID keys are not guessable, but any URL that was ever shared, logged or cached stayed valid forever without its signature. |
| `dev/users/<id>/avatar/*`, `dev/groups/<id>/avatar/*` | 11 | Intentionally public (profile pictures). |

Not exposed:
- Older object versions (versioning is on, but the policy granted only `GetObject`, not `GetObjectVersion`).
- Object ACLs (`BucketOwnerEnforced`: ACLs are disabled).
- Listing (no `ListBucket` grant).

## Evidence of access

**It cannot be established whether anyone outside the team downloaded these objects.**
- Server access logging was **disabled**.
- CloudTrail S3 data events could not be checked: the application's IAM user gets `AccessDenied` on CloudTrail.
- Not having this evidence is not evidence that nothing was accessed.

## Remediation applied (approved, 2026-10-26)

1. The previous policy was saved (scratchpad `policy-backup-2026-10-26.json`, 196 bytes) for rollback.
2. Public Access Block set to `BlockPublicAcls=true`, `IgnorePublicAcls=true`, `BlockPublicPolicy=false`, `RestrictPublicBuckets=false`. The last two must stay off while avatars are public through the policy.
3. Policy replaced with avatars only:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadAvatarsOnly",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": [
      "arn:aws:s3:::<bucket>/dev/users/*/avatar/*",
      "arn:aws:s3:::<bucket>/dev/groups/*/avatar/*",
      "arn:aws:s3:::<bucket>/phase5b-staging/users/*/avatar/*",
      "arn:aws:s3:::<bucket>/phase5b-staging/groups/*/avatar/*"
    ]
  }]
}
```

The application still authorises every private download before signing a URL (unchanged code path: message and recording access checks, then `signedMediaUrl`).

## Verification (real bucket, anonymous requests, no credentials)

One existing object per category; status codes only, keys and contents not recorded.

| Category | Before | After |
|---|---|---|
| Attachment jpg / pdf / webp / png / mp4 | 200 | **403** |
| Recording mp4 | 200 | **403** |
| User avatar png / jpg, group avatar | 200 | 200 (intended) |
| Same private objects via app-style signed URL | — | 200 |

Previously verified at the application layer (Phase 5B, real S3), and unchanged:
- tampered signature, extended expiry, an expired URL, and a URL repurposed for another object are all refused by S3;
- cross-tenant and non-participant API access to recordings and attachments returns 404.

## Required actions (owner / DevOps)

1. **Incident response decision.** Recordings and attachments in this bucket were publicly readable until 2026-10-26. Decide whether notification is needed: are any of those 37 objects real user data rather than team test data? Owner: product owner / data protection lead.
2. **Enable S3 server access logging (or CloudTrail S3 data events)** on this bucket and on any future production bucket, so future access can be audited. Owner: DevOps.
3. **Production bucket, before launch:**
   - **preferred:** a separate public bucket (or CloudFront origin) for avatars only, and all four Public Access Block settings on for the private bucket;
   - **minimum:** the avatar-only policy above, with the production key prefix in place of `dev/`.

   Owner: DevOps.
4. **Treat previously shared attachment URLs as leaked.** After containment they no longer work without a valid signature, so no further action is needed for them.
5. **Optional hardening:** shorten `S3_SIGNED_URL_TTL_SECONDS` (default 6 h). A signed link is a bearer credential until it expires. A shorter TTL means old chat pages need a reload to show media.

## Ongoing check

`webrtc-BE` has no automated check of the bucket policy yet. **Recommended:** a read-only `check:s3` that fails if any policy statement grants `Principal: *` outside `*/users/*/avatar/*` and `*/groups/*/avatar/*`. Owner: backend.

## Rollback

`PutBucketPolicy` with the saved document, and `PutPublicAccessBlock` all false. **Not recommended**: it re-exposes private data.
