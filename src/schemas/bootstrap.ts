import { z } from 'zod';
import { accountSummarySchema } from './account.js';
import { bookSummarySchema, booksQuerySchema, sharedBookSummarySchema } from './book.js';
import { objectId } from './common.js';
import { profileSchema } from './profile.js';

/**
 * `GET /bootstrap` — the one request `[SCR-00]` waits on.
 *
 * `[LOG-24]`'s production wiring step 1 asks for *"session restore + bootstrap in parallel"*, and
 * the client had been doing neither: `App` gated on `/auth/me`, `[SCR-05]` asked for `/accounts`
 * only once that resolved, and `/accounts/:accountId/books` only once **that** resolved, because
 * the account to ask about is derived from the account list. Three dependent round trips, on top of
 * the `401 → /auth/refresh → retry` the 15-minute access cookie makes routine, is five hops before
 * the first book row can paint — measured at roughly two seconds against the deployed service, and
 * none of it parallelisable from the client, because each request needs the previous answer.
 *
 * This is the composite the loader was always specified to wait on. It is deliberately **shaped
 * like the boot**, not like a resource: one profile, the account list, and the books of the one
 * account the app is about to land on.
 */

/**
 * `account` is a **hint, not an instruction** — `nest-ui` reads it out of `localStorage`
 * (`app/lastAccount.ts`), which is a place anything can write.
 *
 * The server resolves the account it actually answers for and echoes it back as `accountId`; a hint
 * naming an account the caller is not a member of is discarded rather than refused, because the
 * boot must succeed for a stale or tampered preference exactly as it does for an absent one. It is
 * optional because a first-ever load has nothing remembered.
 *
 * **A loose string rather than `objectId`, and that is the security-relevant choice.** Validating it
 * at the boundary reads like the safer option and is the more dangerous one here: a malformed value —
 * a browser extension, a corrupted record, one line in DevTools on a shared family phone — would be
 * rejected by the querystring validator before the handler ran, so the boot would answer `400` on
 * every attempt. `400` is not `UNAUTHENTICATED`, so the client lands on `[SCR-00b]` and *Try again*
 * resends the identical hint; the device is unbootable until the user takes *Sign in again*, which
 * costs them a full re-authentication. One family member could do that to another for free.
 *
 * Accepting the string costs nothing, because **nothing is ever done with it except `===` against
 * ids the server already produced** for this caller's own memberships. It never reaches Mongo, never
 * reaches a path, and never widens a query. The length cap is the only bound worth having, so an
 * unbounded body cannot be pushed through a querystring. Found by a security audit.
 *
 * `booksQuerySchema` supplies `month` rather than restating it — the two must agree, since the books
 * this returns are exactly what that query asks for.
 */
export const bootstrapQuerySchema = booksQuerySchema.extend({
  account: z.string().max(64).optional(),
});
export type BootstrapQuery = z.infer<typeof bootstrapQuerySchema>;

/**
 * Every field is the **same schema the dedicated route returns**, never a trimmed copy.
 *
 * That is what lets `nest-ui` seed `queryKeys.profile()`, `queryKeys.accounts()` and
 * `queryKeys.books(accountId)` straight from this payload and leave `useSession`, `useAccounts` and
 * `useBooks` untouched: a narrower boot shape would have made the seeded cache entries disagree
 * with what a later refetch of the same key produces, which is a stale-render bug that only appears
 * on the second visit to a screen.
 */
export const bootstrapSchema = z.object({
  profile: profileSchema,
  accounts: z.array(accountSummarySchema),
  /**
   * The account `books` below belongs to, and the one the app should open — the validated `account`
   * hint, or the caller's first account when the hint is absent, stale or not theirs.
   *
   * `null` when the caller is in no account at all. That is a real state rather than an error:
   * `provisionPersonalAccount` covers sign-up, but every account a user is in can subsequently be
   * left or deleted, and `[SCR-04]` has an empty branch for it.
   */
  accountId: objectId.nullable(),
  /**
   * `[SCR-05]`'s list for `accountId`, or **`null` meaning "not answered here — ask the route"**.
   *
   * Three values, not two, because `[]` already means something: *this account has no books*, which
   * `[LOG-07]`'s NO BOOKS YET branch renders as a settled fact with a create CTA. Two states would
   * therefore have to share it, and both are wrong to show that way — the caller is in no account at
   * all (`accountId` is `null`), or they hold no `viewEntries` on the chosen one, which
   * `GET /accounts/:accountId/books` answers with a `403` and `[SCR-05]` renders as its error branch
   * with a retry.
   *
   * A boot that answered `[]` for either would seed the client's cache with a confident, wrong empty
   * state — the exact false-empty `[LOG-07]` is written against. So the boot declines to answer, the
   * client seeds nothing, and `useBooks` fetches and produces the honest state. Losing one hop for a
   * member an admin has switched `View entries` off is the right trade; that configuration is rare
   * and, per `GET /accounts/:accountId/books`, not designed for in the first place.
   */
  books: z.array(bookSummarySchema).nullable(),
  /**
   * `[GAP-2]`'s guest books — the SHARED WITH ME rows `[OVL-01]` composes beside the account's own,
   * and the same value `GET /shared-with-me` returns.
   *
   * Folded in because it was the one request a launch still made beside this one, and it is a
   * request nobody waits for: it is parallel, correctly excluded from `[SCR-05]`'s loading gate, and
   * read only when the switcher opens. Gating it on the switcher opening was the other option and is
   * worse — it trades a background request for a visible delay the first time someone opens
   * `[OVL-01]`.
   *
   * **A plain array, deliberately not nullable like `books` above**, and the asymmetry is the part
   * worth reading. `books` needs a third value for two structural reasons, and neither has a guest
   * analogue:
   *
   * - `accountId` can be `null` — there may be no account to list books *for*. A guest row is scoped
   *   by `kind: 'guest'` membership alone and needs no account relationship at all.
   * - The books list sits behind a second, later `requireAccount(…, 'viewEntries')` read, so
   *   `[GAP-8]`'s concurrent family edits can flip the answer between the two reads and the boot has
   *   to be able to say *"ask the route"* rather than answer `[]`. This list has no capability gate
   *   above it: the membership query **is** the authorization, and the per-book `resolveBookAccess`
   *   that follows is pure and non-throwing — it drops a row it cannot resolve, it never declines
   *   the list.
   *
   * So `[]` here is unambiguous and always means *"you are a guest in no books"*. `[OVL-01]` already
   * renders that by omitting the section entirely — *"an empty section here would tell every
   * ordinary member they are missing something"* — rather than as an empty state, so there is no
   * `[LOG-07]` false-empty to guard against, which is the whole reason `books` is a third value.
   */
  sharedBooks: z.array(sharedBookSummarySchema),
});
export type Bootstrap = z.infer<typeof bootstrapSchema>;
