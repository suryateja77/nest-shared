import { z } from 'zod';
import {
  monthString,
  moneyTotal,
  objectId,
  signedMoneyAmount,
  signedMoneyTotal,
  timestampsSchema,
} from './common.js';

/**
 * [LOG-01]: `CustomField { name, type: 'text'|'toggle', placeholder? }`. [OVL-08] renders each as
 * "text input or switch", and [SCR-07]'s custom-field builder offers exactly those two.
 */
export const customFieldTypeSchema = z.enum(['text', 'toggle']);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const customFieldSchema = z.object({
  /** Stable id: entry values key off this, so renaming a field must not orphan them. */
  id: objectId,
  name: z.string().min(1).max(40),
  type: customFieldTypeSchema,
  placeholder: z.string().max(60).optional(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

const isUnique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/**
 * Categories and payment modes are grouping keys, not just labels: [LOG-05] aggregates cash-out
 * `byCat` and `byMode` for Insights. A duplicate would silently split one total into two rows, and
 * [SCR-07] lets these be renamed and reordered freely, so uniqueness is enforced here rather than
 * left to the editor.
 */
const uniqueLabels = z.array(z.string().min(1).max(40)).refine(isUnique, 'Entries must be unique');

/**
 * Module-private, exactly as `accountBaseSchema` is, and for a stronger reason than symmetry.
 *
 * `z.infer` of a refined schema is identical to the base object's inferred type, so an exported
 * `bookBaseSchema.parse(x)` would hand back a value typed `Book` that had skipped
 * `creatorIsAMember`. `nest-shared` is the contract; publishing an invariant-free alias of its
 * central entity is the one thing it must not do. It exists only so the input and response schemas
 * below can be cut from it — zod refuses `.pick()`/`.omit()` on an object carrying a refinement.
 */
const bookBaseSchema = z
  .object({
    id: objectId,
    accountId: objectId,
    name: z.string().min(1).max(60),
    /** The book's subtitle, shown as row meta on [SCR-05] — e.g. "Runs since Jan 2026". */
    sub: z.string().max(80).optional(),
    /** Tint used for the book's list-row rail and derived member/book colour hashing ([DS-1]). */
    tint: z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a 6-digit hex color'),
    /** Opening balance. Signed — a book may legitimately start in the red. */
    opening: signedMoneyAmount,
    /**
     * Who created this book. [LOG-01] writes it as a member *name*; it is an id here for the same
     * reason `Account.createdBy` is — the prototype has no user ids at all, and a name is neither
     * unique nor stable across a rename.
     *
     * Load-bearing, not decorative: [LOG-17]'s `isBookCreator` gates **Move**, **Archive** and
     * **Delete book** on [SCR-07], and those rows are *absent* rather than disabled for everyone
     * else. Server-owned — see `createBookInputSchema`.
     */
    createdBy: objectId,
    /**
     * Who can see this book — [LOG-01]'s `members: string[]`, again as ids rather than names.
     *
     * **Visibility, not permission.** What a member may *do* once they can see a book comes from
     * their account role and the account's capability matrix ([LOG-16], [LOG-17]); there is no
     * per-book override and inventing one is [GAP-2]. This list only decides whether the book is
     * theirs to reach at all.
     *
     * [LOG-17] writes `inBook` with a `!b.members` branch for books that predate the field. That
     * branch is deliberately **not** reproduced: `members` is required here and `migrate.ts`
     * backfills every existing book with its account's full membership, which is the same outcome
     * without a permanent "unset means everyone" escape hatch sitting in an access check.
     */
    members: z.array(objectId).refine(isUnique, 'Members must be unique'),
    categories: uniqueLabels,
    paymentModes: uniqueLabels,
    /** Ids must be unique — an entry's `customValues` keys off them. */
    customFields: z
      .array(customFieldSchema)
      .refine((fields) => isUnique(fields.map((field) => field.id)), 'Field ids must be unique'),
    /**
     * Entry-field toggles from [SCR-07]. [OVL-08] states the rule for these two directly —
     * *"category and mode sections appear only if the book enables those fields"* — so an entry may
     * carry no category or payment mode by design.
     */
    useCategory: z.boolean(),
    useMode: z.boolean(),
    /**
     * **What this toggle *does* is not settled, and nothing here should be read as deciding it.**
     *
     * [LOG-01] names it `useAttach` and groups it on one line with the two above, which reads as a
     * third visibility toggle. But [SCR-07] labels the switch "**Require** attachment", the
     * prototype calls the field `requireAttach` and hints `ON ENTRIES ABOVE ₹10,000`, and
     * [OVL-08]'s rules sentence pointedly covers category and mode only. Those describe a
     * conditional *validation* rule, not a show/hide gate — a different control and a different
     * server check.
     *
     * Moot today: [GAP-4] refuses every attachment outright (`entries/entryRules.ts`), so the flag
     * has no live effect either way, and [SCR-07] stores it without acting on it. The decision
     * belongs with whoever builds [GAP-4]; the field name follows [LOG-01] because that is the
     * naming authority, and the name is not the answer.
     */
    useAttach: z.boolean(),
  })
  .merge(timestampsSchema);

/**
 * A book's creator is always one of its members.
 *
 * The design says so twice over: `[OVL-09]`'s picker renders the creator's own row **locked on**,
 * annotated `YOU · ALWAYS HAS ACCESS`, and pressing it flashes *"You always have access to books you
 * create"* rather than unchecking. Enforcing it here closes an incoherence `[LOG-17]` leaves open —
 * its `inBook` special-cases only the *account* creator, so a book creator dropped from `members`
 * would keep `canAdminBook` (Move / Archive / Delete on `[SCR-07]`) over a book they can no longer
 * see. Mirrors `accountSchema`'s creator-is-a-member refinement, for the same reason.
 */
const creatorIsAMember = (book: { createdBy: string; members: string[] }): boolean =>
  book.members.includes(book.createdBy);
const CREATOR_IS_A_MEMBER = 'A book’s creator must be one of its members';

export const bookSchema = bookBaseSchema.refine(creatorIsAMember, CREATOR_IS_A_MEMBER);
export type Book = z.infer<typeof bookSchema>;

/**
 * `accountId` is omitted and server-owned: the book's account is the `:accountId` in
 * `POST /accounts/:accountId/books`, which the server has already resolved and authorized. A copy
 * in the body would be a second, independent claim about which account is being written to — the
 * "trusting `accountId` from the body on create" mistake in `nest-authz`, and the same shape as the
 * one `createEntryInputSchema` carried for `bookId`.
 *
 * **`createdBy` is omitted for the same class of reason**: it is the authenticated caller, which the
 * server already knows. Accepting it in a body would let anyone name someone else as the book's
 * creator, and `[LOG-17]` hangs Move / Archive / Delete off exactly that field.
 *
 * **`members` stays** — it is `[OVL-09]`'s picker, the one genuine user input among the three. The
 * server still validates it against the account's actual membership and force-includes the creator;
 * a client cannot grant sight of a book to someone outside the account by sending their id.
 */
export const createBookInputSchema = bookBaseSchema
  .omit({
    id: true,
    accountId: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    /**
     * Defaulted, because `[OVL-09]` renders no picker at all in a single-member account
     * (`nbShared = acct.members.length > 1`). An omitted list means "just me", which is what the
     * server's force-include of the creator produces.
     */
    members: z.array(objectId).refine(isUnique, 'Members must be unique').default([]),
  });
export type CreateBookInput = z.infer<typeof createBookInputSchema>;

/**
 * **An allowlist of exactly what `[SCR-07]` Book settings edits**, not the create input minus a few
 * fields — the same shape, and the same reasoning, as `updateAccountInputSchema`.
 *
 * `[SCR-07]` offers the name, the three entry-field switches, the custom fields, and the category
 * and payment-mode lists. Nothing else. Everything absent here is absent because no screen changes
 * it, and a contract that can express a change no screen offers is a route waiting to be written
 * against it:
 *
 * - **`opening`** is the sharp one. It is the only field on a book that moves every figure
 *   `[LOG-05]` derives, so a general update rewriting it would silently restate every historical
 *   balance on `[SCR-06]` — with no entry to point at and no undo, which `[LOG-03]` requires on
 *   anything destructive. It looks like an ordinary field and behaves like a destructive one.
 * - **`accountId`** — moving a book between accounts (`[REQ-4]`) needs `bookSettings` on **both**
 *   the source and the destination, so it needs its own authorized operation.
 * - **`createdBy`** is the authenticated creator, and `[LOG-17]` hangs Move, Archive and Delete off
 *   it.
 * - **`members`** — the design has exactly two membership mutations: the initial set at `[OVL-09]`,
 *   and a **self-only** *Leave book* (`[SCR-07]` → `[OVL-17]`), which removes one id and is
 *   undoable. Neither is a bulk replace, and adding a member back is `[GAP-2]`.
 * - **`tint`** and **`sub`** are acquired at creation from the book count and the chosen preset;
 *   `[OVL-09]` offers no control for either and `[SCR-07]` does not edit them.
 *
 * Widening this is a deliberate act when a screen asks for it, which is the point.
 */
export const updateBookInputSchema = bookBaseSchema
  .pick({
    name: true,
    categories: true,
    paymentModes: true,
    /**
     * A **full replacement** of the array, with `id` still required on every entry — which is what
     * makes the three edits `[SCR-07]` offers expressible: a kept field carries its id, a removed
     * one is simply absent, and a new one arrives with an id the *client* minted.
     *
     * **Client-minted ids are the deliberate convention here, matching `createBookInputSchema`**,
     * where `customFieldSchema.id` is likewise required and `routes/accounts.ts` writes it through.
     * Two authority models for one nested type would be worse than either: whoever builds against
     * this would have to know which route they were on, with nothing in the types to tell them.
     *
     * It is also safe, for the reason the create path gives — an id means nothing outside its own
     * book. `bookBaseSchema` refuses duplicates within one, and `entryRules` resolves an entry's
     * `customValues` keys against that book's own fields, so a collision across books is inert. The
     * caller is already rewriting this array wholesale, so choosing an opaque key inside it grants
     * no authority they did not already have — unlike `accountId`, `createdBy` or `bookId`, which
     * name a resource the server must authorize and are omitted everywhere for that reason.
     */
    customFields: true,
    useCategory: true,
    useMode: true,
    useAttach: true,
  })
  .partial();
export type UpdateBookInput = z.infer<typeof updateBookInputSchema>;

/**
 * Derived totals for a book ([LOG-05]). **Never stored** — recomputed from entries on every read.
 *
 * "Never store derived" is not "never transmit derived": [SCR-05] renders a balance on every book
 * row, and a client cannot compute that without fetching every entry of every book. The server
 * computes it per request.
 */
export const bookStatsSchema = z.object({
  /** Totals, not entered amounts — `moneyTotal`, so a long-running book is not rejected by the single-entry ceiling. */
  cin: moneyTotal,
  cout: moneyTotal,
  /** `opening + cin − cout`. Signed — a book may legitimately be in the red. */
  bal: signedMoneyTotal,
});
export type BookStats = z.infer<typeof bookStatsSchema>;

/**
 * A book as [SCR-05]'s list row and [SCR-06]'s ledger header need it.
 *
 * `monthNet` is the row's "+₹82,520 THIS MO." delta — **scoped to `month`**, which the client
 * supplies. The prototype computes that figure over *all* entries while labelling it "THIS MO.";
 * its fixture is a single month so the discrepancy never shows. The label is authoritative.
 */
/**
 * **`members` is withheld**, on the same principle that keeps `contact` and the permissions matrix
 * off `accountSummarySchema`: a field ships when a screen renders it, not because the entity has it.
 *
 * No screen renders a book's member list. `[OVL-09]`'s picker reads the **account's** members, which
 * `AccountSummary` already carries, and `[SCR-07]` lists no membership section at all. The client
 * receives the *effect* of `members` — the book is in its list, or the request 404s — which is all
 * `[LOG-17]` gives it. Shipping the raw array would tell every member which of their household can
 * see each book, for nothing that draws it.
 *
 * **`createdBy` is kept**: `[LOG-17]`'s `isBookCreator` gates `[SCR-07]`'s Move, Archive and Delete
 * rows, which are *absent* rather than disabled for everyone else, so the screen cannot render
 * without it. It discloses nothing new — every account member's id is already on `AccountSummary`.
 */
export const bookSummarySchema = bookBaseSchema.omit({ members: true }).extend({
  stats: bookStatsSchema,
  entryCount: z.number().int().nonnegative(),
  /** `cin − cout` restricted to `month`. Signed, and a total rather than an entered amount. */
  monthNet: signedMoneyTotal,
  /** Echoed back so a client cannot misattribute a delta to the wrong month. */
  month: monthString,
});
export type BookSummary = z.infer<typeof bookSummarySchema>;

/**
 * `GET /accounts/:accountId/books`.
 *
 * `month` is **required**: the server has no defensible default without a timezone, and silently
 * picking one would make a visible money figure wrong in a way nobody could see.
 */
export const booksQuerySchema = z.object({ month: monthString });
export type BooksQuery = z.infer<typeof booksQuerySchema>;
