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

export const bookBaseSchema = z
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
     * Entry-field toggles from [SCR-07]. [OVL-08] reads these to decide which sections of the entry
     * sheet render at all, so an entry may carry no category or payment mode by design.
     */
    useCategory: z.boolean(),
    useMode: z.boolean(),
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
 * Same omission, for a second reason: moving a book between accounts ([REQ-4]) needs `bookSettings`
 * on **both** the source and the destination account, so it must not be reachable through a general
 * update either.
 *
 * **`members` is omitted too, deliberately rather than by inheritance.** The design has exactly two
 * membership mutations — the initial set at `[OVL-09]`, and a **self-only** *Leave book*
 * (`[SCR-07]` → `[OVL-17]`), which removes one id and is undoable. Neither is a bulk replace, and
 * adding a member back is `[GAP-2]`. Letting `.partial()` carry `members` through would open a
 * general "rewrite who can see this book" path that no screen offers and no route authorizes.
 * `updateAccountInputSchema` excludes account members for the identical reason.
 */
export const updateBookInputSchema = createBookInputSchema.omit({ members: true }).partial();
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
