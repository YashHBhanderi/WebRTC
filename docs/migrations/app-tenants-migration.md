# Migration `2026-11-16-app-tenants`: staging validation and production deployment

This release adds application tenants and app-managed users. It contains **one database migration**. It has been run only against in-memory test databases. **It has not been run against staging or production**, and must not be run on production until the staging steps below pass.

Owners: backend lead (review, staging run), DevOps (backup, deployment, production run).

## What the migration does

| Step | Collection | Change | Reversible |
|---|---|---|---|
| 1 | `tenants` | Drops unique index `clerkOrgId_1`, recreates it **partial** (unique among tenants that have a Clerk organization) | Yes (section 6) |
| 2 | `users` | Drops unique index `email_1`, recreates it **partial** (unique among users that have an account email) | Yes |
| 3 | `users`, `tenants`, `tenantmemberships`, `developer_apps`, `app_grants`, `app_usage` | Creates new indexes (`users {tenantId, externalUserId}` unique partial, `users {tenantId, contactEmail}`, `tenants {appId}` unique partial) | Yes |
| 4 | `developer_apps`, `tenants` | Sets `dedicatedTenant: false` / `kind: "organization"` where the field is missing | Yes (values equal the defaults) |

- No document is deleted and no existing value is changed. Existing data satisfies the new indexes because it satisfied the old, stricter ones.
- It is idempotent and recorded in the `migrations` collection under `_id: "2026-11-16-app-tenants"`.
- **Risk window:** between dropping and recreating `email_1` / `clerkOrgId_1` (the index build on `users`: seconds for small collections, longer for large ones) uniqueness of emails and organization ids is not enforced by the database. Run it in a low-traffic window. Sign-up during that window could create a duplicate email, which would then make the index build fail (the migration stops with an error and can be re-run after removing the duplicate).

## IMPORTANT: the server runs migrations at startup

`src/server.ts` runs pending migrations on every start **unless `RUN_MIGRATIONS=false`**. Deploying this release to production with the default setting applies the migration immediately.

To control when it runs, production must start the new release with:

```
RUN_MIGRATIONS=false
```

and the migration is then applied on purpose with `npm run migrate` (section 4).

Running the new code **before** the migration is safe for everything that exists today: the server starts and existing features work (the index conflict surfaces only as a Mongoose index event, not as a crash; verified against a database with the old indexes). Until the migration runs, the new features answer `503`: registering a second application from the personal context, and registering a second app user.

## 1. Before staging

- [ ] Code review of the migration (`webrtc-BE/src/migrations/index.ts`, entry `2026-11-16-app-tenants`) and of `test/app-tenants-migration.test.ts`.
- [ ] Backend tests green on the release build: `cd webrtc-BE && npm test`.

## 2. Staging validation

Use a staging database restored from a **recent production backup** (same data shape and size), never production itself.

1. Record the starting state (mongosh, staging):

   ```js
   db.users.getIndexes().filter(i => i.name === "email_1")
   db.tenants.getIndexes().filter(i => i.name === "clerkOrgId_1")
   db.users.countDocuments(); db.tenants.countDocuments(); db.developer_apps.countDocuments()
   // must both be empty: duplicates would block the new indexes
   db.users.aggregate([{ $match: { email: { $type: "string" } } }, { $group: { _id: "$email", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
   db.tenants.aggregate([{ $match: { clerkOrgId: { $type: "string" } } }, { $group: { _id: "$clerkOrgId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
   ```

2. Deploy the release to staging with `RUN_MIGRATIONS=false`. Confirm the server starts and existing features work (sign in, chat, a call).
3. Run the migration and note how long it takes:

   ```
   cd webrtc-BE && npm run migrate
   ```

   Expected log line: `[migrations] 2026-11-16-app-tenants: replaced tenants.clerkOrgId_1, users.email_1; N app(s) marked legacy, M tenant(s) marked organization`.
4. Verify:

   ```js
   db.migrations.findOne({ _id: "2026-11-16-app-tenants" })                       // present, with the result text
   db.users.getIndexes().find(i => i.name === "email_1")                          // unique: true, partialFilterExpression: { email: { $type: "string" } }
   db.tenants.getIndexes().find(i => i.name === "clerkOrgId_1")                   // unique: true, partialFilterExpression: { clerkOrgId: { $type: "string" } }
   db.users.getIndexes().find(i => i.key.tenantId === 1 && i.key.externalUserId === 1)   // unique: true
   db.users.countDocuments(); db.tenants.countDocuments(); db.developer_apps.countDocuments()   // unchanged
   db.developer_apps.countDocuments({ dedicatedTenant: true })                    // 0: existing apps are untouched
   ```

5. Run `npm run migrate` a second time: it must report nothing to do.
6. Functional checks on staging:
   - [ ] Existing personal app: sign in, direct chat, group, call, meeting.
   - [ ] Existing organization workspace: members, teams, external chat (if enabled).
   - [ ] An **existing** consent / OAuth application still issues tokens and its users still see their data.
   - [ ] Register a new application from the personal context: it shows "own tenant" and a Users tab.
   - [ ] Register two users (portal and `POST /v1/app-users`), get tokens, chat and call between them.
   - [ ] Register a second application with its own users: neither side can find, message or open anything of the other (directory, search, profile by ID, conversation by ID).
   - [ ] A SpreeWe account can't find or message an app user.
   - [ ] Deactivate an app user: token refused, removed from the directory.
7. Record the migration duration and the results in the release ticket. **Do not proceed to production without sign-off from the backend lead.**

## 3. Production: before deployment

- [ ] Staging validation signed off.
- [ ] Fresh backup of the production database taken and restore-tested (or a point-in-time recovery window confirmed).
- [ ] Duplicate checks from step 2.1 run on production (read-only): both empty.
- [ ] Low-traffic window agreed; migration duration from staging known.
- [ ] `RUN_MIGRATIONS=false` set in the production environment.

## 4. Production: deployment order

1. Deploy `webrtc-BE` with `RUN_MIGRATIONS=false`. Existing features keep working; new application registration answers `503` until step 2.
2. In the agreed window, run the migration **once**, from one instance: `cd webrtc-BE && npm run migrate`.
3. Verify with the queries from step 2.4.
4. Deploy `webrtc-FE` (Developer Portal: Users tab, no consent settings for new applications).
5. Publish the SDK when you are ready (`@spreewe/core/server` is additive).
6. Smoke test: register a test application, one user, one token; then delete the test application.

The backend must be deployed before the frontend: the portal's Users tab calls routes that only exist in this release.

## 5. If something goes wrong

- **The migration fails part-way** (for example an index build error): nothing is recorded in `migrations`, so it can be re-run after fixing the cause. If `email_1` or `clerkOrgId_1` was dropped and not recreated, recreate it at once with the partial definition from step 2.4.
- **A problem in the new features after deployment:** disable affected applications in the portal, or roll back the code (section 6). Existing features don't depend on the new indexes.

## 6. Rollback

The previous release works with the migrated indexes as long as **no application tenant or app user exists yet**. Once they exist, the old non-partial indexes can't be restored (several documents have no `email` / `clerkOrgId`).

- Roll back code only: redeploy the previous `webrtc-BE` and `webrtc-FE`. Applications created with their own tenant stop being usable by the old code (their tokens are refused); nothing else is affected.
- Restore the old indexes (only if no application tenants / app users exist):

  ```js
  db.users.dropIndex("email_1");        db.users.createIndex({ email: 1 }, { unique: true })
  db.tenants.dropIndex("clerkOrgId_1"); db.tenants.createIndex({ clerkOrgId: 1 }, { unique: true })
  db.migrations.deleteOne({ _id: "2026-11-16-app-tenants" })
  ```
