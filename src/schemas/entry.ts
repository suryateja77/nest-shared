import { z } from 'zod';
import {
  dateOnlyString,
  moneyAmount,
  objectId,
  timeOfDayString,
  timestampsSchema,
} from './common.js';
import { paginated, paginationQuerySchema, queryList } from './http.js';

export const entryTypeSchema = z.enum(['in', 'out']);
export type EntryType = z.infer<typeof entryTypeSchema>;

/**
 * [GAP-4] — real upload is unbuilt. `name` and `mimeType` are **client-supplied and untrusted**:
 * the server must sniff the actual bytes against an allowlist (image + PDF per [REQ-5]) and
 * generate the object key itself. Never interpolate `name` into a storage path.
 */
export const attachmentSchema = z.object({
  url: z.url(),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const entrySchema = z
  .object({
    id: objectId,
    bookId: objectId,
    type: entryTypeSchema,
    amount: moneyAmount,
    /** [OVL-08]'s REMARK field — `desc` in the prototype. */
    remark: z.string().max(200).optional(),
    /** Absent when the book has `useCategory` / `useMode` off ([SCR-07]). */
    category: z.string().optional(),
    paymentMode: z.string().optional(),
    /**
     * The ledger's grouping key ([SCR-06]).
     *
     * **Server-assigned at creation and never editable.** [OVL-08] has no date picker — its record
     * line is display-only — the prototype stamps `d`/`t` with the current clock and explicitly
     * preserves both across an edit, and Munim's `chatCreateEntry` takes no date either. Stored
     * separately from `createdAt` because grouping is a local-calendar operation, not an instant.
     */
    date: dateOnlyString,
    /** 24-hour `HH:mm`. `9:41 PM` is display formatting ([LOG-06] timeTok), not storage. */
    time: timeOfDayString,
    /**
     * `who` in [LOG-01] — who created the entry. Metadata, not a user-entered field: it is shown on
     * [OVL-08]'s record line, drives Insights' "WHO SPENT IT" ([SCR-11]), and the prototype
     * preserves it across edits. Server-assigned from the session, never accepted from the client.
     */
    createdBy: objectId,
    /** Set when the entry is edited — the prototype's `editedBy`. */
    updatedBy: objectId.optional(),
    /**
     * Values keyed by the book's `customFields[].id` — the key type is enforced, so a stray label
     * or index cannot be written in place of an id. `string` for a text field, `boolean` for a
     * toggle ([LOG-01]).
     */
    /**
     * The text bound matches `remark`'s 200. Without one the only ceiling is the 1 MB body limit,
     * and a ledger page of 100 such entries becomes a ~100 MB response every member of the account
     * pays for on `[SCR-06]`. `[OVL-08]` renders a text custom field as a single-line input, so
     * nothing the design can produce comes close.
     */
    customValues: z.record(objectId, z.union([z.string().max(200), z.boolean()])).optional(),
    attachment: attachmentSchema.optional(),
  })
  .merge(timestampsSchema);
export type Entry = z.infer<typeof entrySchema>;

/**
 * Omitted and server-owned:
 * - `bookId` — the entry's book is the `:bookId` in `POST /books/:bookId/entries`, which the server
 *   has already resolved and authorized. A second copy in the body would be an independent claim
 *   about which book is being written to, and the server would then have two answers to one
 *   question — the "trusting `bookId` from the body on create" mistake in `nest-authz`. Omitted so
 *   it cannot be sent at all.
 * - `createdBy` / `updatedBy` — derived from the authenticated session. Accepting them from the
 *   client would let a member attribute spending to someone else, which Insights then reports
 *   ([SCR-11] "WHO SPENT IT").
 * - `date` / `time` — stamped from the clock. [OVL-08] offers no way to set them.
 */
export const createEntryInputSchema = entrySchema.omit({
  id: true,
  bookId: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  date: true,
  time: true,
});
export type CreateEntryInput = z.infer<typeof createEntryInputSchema>;

/** Same server-owned fields; moving an entry between books is not a designed operation either. */
export const updateEntryInputSchema = createEntryInputSchema.partial();
export type UpdateEntryInput = z.infer<typeof updateEntryInputSchema>;

/**
 * [OVL-04]'s **DATE RANGE** chips, verbatim from the prototype's `RANGES`
 * (`ANY DATE`, `TODAY`, `LAST 7 DAYS`, `LAST 30 DAYS`, `THIS MONTH`).
 *
 * **A token, resolved by the server, rather than a `from`/`to` pair resolved by the client.**
 * `Entry.date` is a wall-clock `YYYY-MM-DD` stamped in the service's `APP_TIMEZONE`, so a range
 * over it is only correct when computed in that same zone. A browser in another zone asking for
 * `TODAY` would resolve its own calendar day and miss entries stamped either side of the boundary —
 * including, at 02:00 IST from a UTC browser, the one just added.
 *
 * This is deliberately *not* the convention `booksQuerySchema` uses for `month`, where the client
 * names the month. That is a different question: there the client picks *which* month and the
 * server does an arithmetic range, whereas here the client would have to answer "what is today",
 * which only the stamping zone can.
 */
export const entryDateRangeSchema = z.enum(['all', 'today', '7d', '30d', 'month']);
export type EntryDateRange = z.infer<typeof entryDateRangeSchema>;

/**
 * [OVL-04]'s filter set — the prototype's
 * `{ type, range, cats: [], modes: [], who: [] }`, and its `matches()` predicate is the semantics:
 * every dimension is ANDed, and each list is an OR within itself ("PICK ANY").
 *
 * **`type` absent is the prototype's `'all'`.** An explicit `'all'` member would make two values
 * mean the same thing on the wire, and the ALL chip is a *cleared* filter rather than a third
 * direction — `fCount` counts it as zero.
 *
 * Applied in the query, never after the fetch. The ledger is cursor-paged, so filtering a loaded
 * page would report "Nothing matches" while matching entries sat unloaded on page two — and
 * `nest-authz` requires list scoping to happen in the query regardless.
 */
export const entryFilterQuerySchema = z.object({
  type: entryTypeSchema.optional(),
  range: entryDateRangeSchema.default('all'),
  /** Free-text labels off the book's own lists, so bounded the same way `uniqueLabels` bounds them. */
  categories: queryList(z.string().min(1).max(40)),
  paymentModes: queryList(z.string().min(1).max(40)),
  /** [OVL-04]'s **ADDED BY**. `Entry.createdBy`, so ids — the prototype's `who` is a name only because it has no user records. */
  createdBy: queryList(objectId),
});
export type EntryFilterQuery = z.infer<typeof entryFilterQuerySchema>;

/**
 * `GET /books/:bookId/entries` — the ledger ([SCR-06]).
 *
 * Ordered `date desc, time desc, id desc`, newest first, which is what the screen renders.
 *
 * Newest-first also lets the client derive each row's running balance from the book balance
 * ([LOG-05]) — but **only while unfiltered**: that derivation is "book balance minus everything
 * newer", and under a filter the rows are a subset, so everything newer is no longer all loaded.
 * `[SCR-06]` item 7 makes the running-balance column conditional for exactly this kind of reason;
 * see `LedgerScreen` for where it is dropped.
 */
export const entriesQuerySchema = paginationQuerySchema.extend(entryFilterQuerySchema.shape);
export type EntriesQuery = z.infer<typeof entriesQuerySchema>;

/**
 * `GET /books/:bookId/entries/facets` — the two figures [OVL-04] needs that the page cannot give it.
 *
 * The sheet edits a **draft** copy of the filters and only applies it on confirm (`fDraft`), so its
 * "Show 12 entries" button describes a filter the ledger is not currently showing. That count
 * cannot come from the entries page, which is both paginated and fetched under the *applied*
 * filters.
 */
export const entryFacetsSchema = z.object({
  /** How many entries match the filters sent with **this** request — the prototype's `previewCount`. */
  matches: z.number().int().nonnegative(),
  /**
   * Distinct `createdBy` over the **whole book**, deliberately ignoring the request's filters.
   *
   * The prototype derives its ADDED BY chips the same way (`Object.keys(book.entries.reduce(...))`)
   * — from who has actually written in this book, not from who *could*. Filtering this list by the
   * draft would make chips vanish as soon as one was picked.
   *
   * Not `book.members` either: that is visibility ([LOG-17]), and the account's creator can write in
   * a book without appearing in it, so a members-derived list would omit a real author.
   */
  authors: z.array(objectId),
});
export type EntryFacets = z.infer<typeof entryFacetsSchema>;

/** `{ items, nextCursor }` of entries. */
export const entriesPageSchema = paginated(entrySchema);
export type EntriesPage = z.infer<typeof entriesPageSchema>;
