# nest-shared

Shared TypeScript types and [zod](https://zod.dev) schemas for the Nest family expense app. Consumed by `nest-ui` and `nest-data-service` as a compile-time contract — this package has **no runtime server or process**, it's just types and validators.

See [`../TECH_STACK.md`](../TECH_STACK.md) for how this fits into the overall architecture.

## What's in here

- `src/schemas/common.ts` — shared primitives (`objectId`, `isoDateString`, `moneyAmount`, `timestampsSchema`)
- `src/schemas/role.ts` — `Role` enum and the six-capability `Permissions` matrix
- `src/schemas/account.ts`, `book.ts`, `entry.ts`, `due.ts`, `reminder.ts`, `invite.ts` — one file per domain entity, each exporting:
  - the full entity schema/type (as stored)
  - a `create*InputSchema`/`Create*Input` (what the API accepts to create one)
  - an `update*InputSchema`/`Update*Input` where partial updates make sense

Everything is re-exported from `src/index.ts`.

## Consuming this package

Both `nest-ui` and `nest-data-service` depend on this repo as a **git dependency** rather than a published npm package:

```json
{
  "dependencies": {
    "nest-shared": "git+https://github.com/<org>/nest-shared.git#v0.1.0"
  }
}
```

Installing a git dependency runs this package's `prepare` script automatically, which builds `dist/` (ESM + CJS + `.d.ts`) via `tsup` — consumers never need to build it manually.

When you change a schema here, bump the version in `package.json`, tag the commit (`git tag v0.x.y && git push --tags`), and update the pinned tag in each consumer's `package.json`.

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
