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

export const bookSchema = z
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
export type Book = z.infer<typeof bookSchema>;

/**
 * `accountId` is omitted and server-owned: the book's account is the `:accountId` in
 * `POST /accounts/:accountId/books`, which the server has already resolved and authorized. A copy
 * in the body would be a second, independent claim about which account is being written to — the
 * "trusting `accountId` from the body on create" mistake in `nest-authz`, and the same shape as the
 * one `createEntryInputSchema` carried for `bookId`.
 */
export const createBookInputSchema = bookSchema.omit({
  id: true,
  accountId: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateBookInput = z.infer<typeof createBookInputSchema>;

/**
 * Same omission, for a second reason: moving a book between accounts ([REQ-4]) needs `bookSettings`
 * on **both** the source and the destination account, so it must not be reachable through a general
 * update either.
 */
export const updateBookInputSchema = createBookInputSchema.partial();
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
export const bookSummarySchema = bookSchema.extend({
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
