# nest-shared

Shared TypeScript types and [zod](https://zod.dev) schemas for the Nest family expense app. Consumed by `nest-ui` and `nest-data-service` as a compile-time contract — this package has **no runtime server or process**, it's just types and validators.

See [`../TECH_STACK.md`](../TECH_STACK.md) for how this fits into the overall architecture.

## What's in here

- `src/schemas/common.ts` — shared primitives (`objectId`, `moneyAmount`, `timestampsSchema`, and the **three distinct temporal types**: `dateOnlyString`, `localDateTimeString` for zone-less wall clocks, `isoDateString` for instants — do not mix them)
- `src/schemas/http.ts` — the transport envelope: `apiErrorSchema`, `errorCodeSchema`, the `{ items, nextCursor }` list shape
- `src/schemas/role.ts` — the `Role` enum and the six-capability `Permissions` matrix. `OWNER` is real but **not assignable**: its capabilities are the frozen `OWNER_PERMISSIONS`, kept outside the editable matrix so `[SCR-08]` cannot strip the account creator's rights
- `src/schemas/account.ts`, `book.ts`, `entry.ts`, `due.ts`, `reminder.ts`, `invite.ts` — one file per domain entity, each exporting:
  - the full entity schema/type (as stored)
  - a `create*InputSchema`/`Create*Input` (what the API accepts to create one)
  - an `update*InputSchema`/`Update*Input` where partial updates make sense
- `src/schemas/profile.ts` — the signed-in user's own record (`[SCR-12]`/`[SCR-12b]`)
- `src/schemas/auth.ts` — sign-in payloads. Both flows live here: the OTP schemas (`[SCR-02]`/`[SCR-03]`, awaiting a vendor) and the password ones (`signUpInputSchema`, `signInInputSchema`) that are the interim flow in use today

Everything is re-exported from `src/index.ts`.

Two standing decisions that are contract-level, not call-site choices: **amounts are integer rupees**
(the frozen design never renders paise), and **entered amounts and derived totals are different
types** — `moneyAmount` caps at `MAX_ENTRY_AMOUNT`, `moneyTotal` does not, because a household book
passes a crore of lifetime cash-in without anything unusual happening.

## Consuming this package

Both `nest-ui` and `nest-data-service` depend on this repo as a **git dependency** rather than a published npm package, pinned to a tag:

```json
{
  "dependencies": {
    "nest-shared": "github:suryateja77/nest-shared#v0.8.0"
  }
}
```

Installing a git dependency runs this package's `prepare` script automatically, which builds `dist/` (ESM + CJS + `.d.ts`) via `tsup` — consumers never need to build it manually.

### Shipping a schema change

A change here is **not live in either consumer** until it has been committed, tagged, pushed, and the tag bumped in both. In full:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
# bump "version" in package.json
git commit -am "…" && git tag -a v0.x.y -m "…"
git push origin main && git push origin v0.x.y
# then in each consumer: edit the tag in package.json by hand, and
pnpm install
```

**Three sharp edges, all of which have bitten at least once:**

1. **`pnpm add "github:…#vX.Y.Z"` silently strips the tag**, leaving a bare URL that resolves to the default branch on any fresh install. The lockfile still pins a SHA, so it looks fine. **Write the specifier by hand**, then confirm both `package.json` and the lockfile carry `#vX.Y.Z`.
2. **The tag must be pushed before a consumer installs** — pnpm fetches from GitHub, not your local clone. `git ls-remote --tags origin` before bumping.
3. **Consumers need `allowBuilds: nest-shared` in `pnpm-workspace.yaml`.** `dist/` is gitignored, so the `prepare` script has to run at install time, and pnpm 11 blocks that by default.

The round-trip cost is real and known — see `TECH_STACK.md` for why four repos won anyway.

## Local development

```bash
pnpm install
pnpm run dev          # tsup --watch
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run format
```

Git hooks (lint-staged on commit) aren't wired into `prepare`, since `prepare` is reserved for the build consumers need — run this once after cloning to enable them locally:

```bash
pnpm exec husky
```

## Adding a new entity

1. Add `src/schemas/<entity>.ts` following the pattern in an existing file (base schema → `create*InputSchema` via `.omit()` → `update*InputSchema` via `.partial()`).
2. Re-export it from `src/index.ts`.
3. Add a couple of parse/reject cases to `src/schemas/schemas.test.ts`.
4. Ship it — see [Shipping a schema change](#shipping-a-schema-change). A schema nobody has tagged does not exist as far as the consumers are concerned.

**Never widen a type at a call site.** If a consumer needs a field that isn't here, the fix is here, not there — that is the whole reason this package exists. `/nest-contract-check` compares these schemas against the frozen data model in `[LOG-01]`; run it before building on a type you have not touched recently.
