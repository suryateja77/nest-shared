import { z } from 'zod';
import {
  dateOnlyString,
  isoDateString,
  moneyAmount,
  objectId,
  timeOfDayString,
  timestampsSchema,
} from './common.js';
import { MAX_CUSTOM_FIELDS } from './book.js';
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
     * **The client may now set it, and that is a deliberate override of the frozen design.**
     * `[OVL-08]` has no date picker — its record line is display-only, the prototype stamps `d`/`t`
     * from the current clock and explicitly preserves both across an edit — and the user asked for
     * one after device testing: *"give the ability for the user to also select the entry date and
     * time … Defaults to current date and time."* `DECISIONS.md` records it; the export will keep
     * re-asserting the original.
     *
     * Still **wall clock in the service's `APP_TIMEZONE`**, not an instant, and stored separately
     * from `createdAt` for that reason: grouping a ledger by day is a local-calendar operation. That
     * is also why a client can send this at all without a zone negotiation — `dateOnlyString` and
     * `timeOfDayString` are zone-less by construction, so the value the user picks in a date input
     * *is* the value stored.
     *
     * The bound that is **not** in this schema and must not be moved here: an entry may not be dated
     * in the future. That compares against the server's clock in its own zone, which no client-side
     * schema can do — `entryRules.assertEntryDateIsNotFuture` owns it.
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
     *
     * **The key count is bounded for the same reason the value length is**, and it was the hole the
     * value bound left open: 20 000 boolean values carry no long strings at all and still make one
     * `limit=100` page a ~64 MB response whose every key is run through the `objectId` regex. Capped
     * against `MAX_CUSTOM_FIELDS` rather than a number of its own — a value keyed by an id that is
     * not one of the book's fields is already refused by `entryRules`, so a legitimate entry can
     * never carry more values than its book has fields.
     */
    customValues: z
      .record(objectId, z.union([z.string().max(200), z.boolean()]))
      .refine((values) => Object.keys(values).length <= MAX_CUSTOM_FIELDS, {
        message: `A book has at most ${String(MAX_CUSTOM_FIELDS)} custom fields`,
      })
      .optional(),
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
 *
 * **`date` and `time` used to be on that list and no longer are** — `[OVL-08]` has a date and time
 * picker by the user's decision. They stay **optional**, which is what keeps the frozen behaviour as
 * the default: omit them and the server stamps its own clock exactly as before, which is what Munim's
 * `chatCreateEntry` will do when it lands (`[LOG-11]` parses no date) and what any client that has
 * not been updated does. `.partial()` is applied to the pair rather than the schema, so no other
 * field's requiredness changes — `remark`, `category`, `paymentMode`, `customValues` and `attachment`
 * were already optional on `entrySchema` and stay that way.
 *
 * They are **not** a way to smuggle authorship: `createdBy` is still session-derived, so a backdated
 * entry still says who actually wrote it.
 */
export const createEntryInputSchema = entrySchema
  .omit({
    id: true,
    bookId: true,
    createdAt: true,
    updatedAt: true,
    createdBy: true,
    updatedBy: true,
  })
  .partial({ date: true, time: true });
export type CreateEntryInput = z.infer<typeof createEntryInputSchema>;

/**
 * `PUT /books/:bookId/entries/:entryId` — `[OVL-08]` in edit mode.
 *
 * **A replacement, not a patch**, and the same body as create plus one precondition. It was briefly
 * `createEntryInputSchema.partial()` with no caller, and that shape was wrong rather than merely
 * unused: `.partial()` gives merge semantics, under which *"the user cleared the remark"* and *"the
 * client did not mention the remark"* arrive as the same request — so a cleared remark, category or
 * custom value could never be saved, silently and permanently. `[OVL-08]` is *"the same sheet …
 * pre-filled, with the save label changed"* and submits every editable field, so the honest shape is
 * a replacement: the server `$unset`s what the body omits.
 *
 * (`Due` and `Reminder` face the same question and answer it the other way — their clearable fields
 * are `.nullable()`, so a `PATCH` can still express "clear this". Either is correct; what is not is
 * an optional field under merge semantics, which cannot be emptied at all.)
 *
 * ### `expectedUpdatedAt` — the entry's `updatedAt` as the client last saw it
 *
 * A whole-body replacement makes concurrent editing worse than a patch would: the second saver
 * reverts **every** field the first changed, not just the one they touched, because both sheets hold
 * a snapshot taken when they opened. Two family members editing one entry is `[GAP-8]`, and the
 * failure is silent — no error, no `CONFLICT`, and `[LOG-03]` offers no undo for an edit.
 *
 * So the client sends back the `updatedAt` it loaded and the server refuses with `CONFLICT` if the
 * stored one has moved. Optimistic, not a lock: nothing is held, nothing expires, and two people
 * editing *different* entries never interact.
 *
 * **Optional, so the precondition is the client's to offer.** An older client that does not send it
 * keeps the previous last-write-wins behaviour rather than being refused outright, which is the same
 * reason `date`/`time` are optional above. `nest-ui` always sends it.
 *
 * `bookId` stays omitted, as on create. `[LOG-21]` made moving an entry between books designed, but
 * not as a field a client may set: a move is *"a copy plus a hard delete of the originals"*, so the
 * entry that lands in the destination is a **new** document with a new id, and the original is
 * removed rather than repointed. See `bulkTransferEntriesInputSchema`.
 */
export const updateEntryInputSchema = createEntryInputSchema.extend({
  expectedUpdatedAt: isoDateString.optional(),
});
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
 * `GET /books/:bookId/entries/count` — [OVL-04]'s "Show 12 entries" button label.
 *
 * The sheet edits a **draft** copy of the filters and only applies it on confirm (`fDraft`), so its
 * count describes a filter the ledger is not currently showing. That cannot come from the entries
 * page, which is both paginated and fetched under the *applied* filters.
 */
export const entryCountSchema = z.object({
  /** How many entries match the filters sent with **this** request — the prototype's `previewCount`. */
  matches: z.number().int().nonnegative(),
});
export type EntryCount = z.infer<typeof entryCountSchema>;

/**
 * `GET /books/:bookId/entries/authors` — [OVL-04]'s **ADDED BY** chips.
 *
 * Distinct `createdBy` over the whole book. The prototype derives the same set the same way
 * (`Object.keys(book.entries.reduce(...))`) — from who has actually written here, not from who
 * *could*. Not `book.members` either: that is visibility ([LOG-17]), and the account's creator can
 * write in a book without appearing in it, so a members-derived list would omit a real author.
 *
 * **A separate request from the count, deliberately**, though one sheet reads both. This answer does
 * not vary with the filters and the count varies with every chip tap, so serving them together made
 * the client re-fetch an unfiltered whole-book scan per keystroke. Two lifetimes, two routes, two
 * cache keys.
 */
export const entryAuthorsSchema = z.object({
  authors: z.array(objectId),
});
export type EntryAuthors = z.infer<typeof entryAuthorsSchema>;

/** `{ items, nextCursor }` of entries. */
export const entriesPageSchema = paginated(entrySchema);
export type EntriesPage = z.infer<typeof entriesPageSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * [LOG-21] — selection mode and bulk operations
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many entries one bulk operation may name.
 *
 * A bound rather than none, for the reason `MAX_QUERY_LIST_VALUES` has one: every id becomes part of
 * a Mongo `$in`, and each one then costs a document write on one of four paths. Unbounded, a single
 * request could name every entry the caller can see.
 *
 * **500 is ten full ledger pages** (`DEFAULT_PAGE_SIZE`), which is what makes it safely above the
 * interaction rather than an arbitrary round number: `[OVL-25]`'s *Select all* picks *"the filtered
 * visible list"*, and on a cursor-paged ledger "visible" means loaded. Reaching the cap therefore
 * takes ten deliberate presses of *Load older entries* before the selection even starts.
 */
export const MAX_BULK_ENTRIES = 500;

/**
 * The selection every bulk operation acts on — `[LOG-21]`'s `sel`.
 *
 * **Ids, never a filter.** The alternative — sending `entryFilterQuerySchema` and letting the server
 * act on everything that matches — was rejected on two grounds. The acted-on set would be resolved
 * twice, once for `[OVL-27]`'s preview and again at commit, so an entry added in between would be
 * silently swept into a delete the user never saw named; and `[LOG-03]`'s undo has to restore a
 * *specific* set, which a filter cannot name after the fact.
 *
 * `.min(1)`: every one of the four operations is a no-op on an empty selection, and `[LOG-21]`
 * makes an empty selection unrepresentable anyway — `toggleSel` *"returns to `null` when the last
 * row is unchecked"*, so there is no state in which the bar's buttons are pressable with nothing
 * picked. A request carrying zero ids is a client bug, and answering `400` says so.
 */
const bulkEntrySelectionSchema = z.object({
  entryIds: z.array(objectId).min(1).max(MAX_BULK_ENTRIES),
});

/**
 * `POST /books/:bookId/entries/bulk-delete` — `[OVL-28]` in bulk mode.
 *
 * The ids alone. The book is the authorized `:bookId`, and every id is confirmed to live in it
 * server-side — see `entries.ts`, where that check is the whole security of this feature.
 */
export const bulkDeleteEntriesInputSchema = bulkEntrySelectionSchema;
export type BulkDeleteEntriesInput = z.infer<typeof bulkDeleteEntriesInputSchema>;

/**
 * `POST /books/:bookId/entries/bulk-copy` and `…/bulk-move` — `[OVL-27]`.
 *
 * **One body shape, two routes, and that is deliberate.** `[OVL-27]` is *"one component, `bulk: {
 * mode: 'copy'|'move', to }`"*, so a single route taking a `mode` would have mirrored the UI exactly
 * — and it would have let a **body value select the authorization path**, because a move additionally
 * requires `deleteEntries` on the source where a copy does not. A gate chosen by the payload it is
 * meant to gate is the shape `nest-authz` exists to forbid, so the mode lives in the URL, where each
 * route states its own capability. The sheet stays one component.
 *
 * **No `mode` field, and no flag saying which labels to create.** `[LOG-21]` creates *"missing
 * labels … in the destination"*, and which are missing is a fact about two documents the server has
 * already loaded. A client-supplied list would be a claim the server would have to re-derive to
 * trust, so it derives it and reports what it did in `BulkTransferEntriesResult`.
 */
export const bulkTransferEntriesInputSchema = bulkEntrySelectionSchema.extend({
  destinationBookId: objectId,
});
export type BulkTransferEntriesInput = z.infer<typeof bulkTransferEntriesInputSchema>;

/** Which of `[OVL-26]`'s two lists is being stamped — the prototype's `selSet.kind`. */
export const bulkEntryLabelFieldSchema = z.enum(['category', 'paymentMode']);
export type BulkEntryLabelField = z.infer<typeof bulkEntryLabelFieldSchema>;

/**
 * `POST /books/:bookId/entries/bulk-label` — `[OVL-26]`, both of its paths.
 *
 * Tapping an existing row and pressing **Add & apply** on a typed name send the *same* request: a
 * field and a value. `[OVL-26]` already collapses them itself — *"Typing an existing name just
 * applies it"* — and whether the value is new is a fact about the book's own list, which the server
 * holds. Deriving it there rather than accepting a `createLabel` flag matters because the answer
 * **selects a capability**: creating a label is a `bookSettings` write, applying an existing one is
 * not, so a client-set flag would let the client pick its own gate.
 *
 * `.max(40)` matches `entryFilterQuerySchema`'s bound on the same labels, and `uniqueLabels` in
 * `book.ts` is what the value is measured against once it lands.
 */
export const bulkLabelEntriesInputSchema = bulkEntrySelectionSchema.extend({
  field: bulkEntryLabelFieldSchema,
  value: z.string().trim().min(1).max(40),
});
export type BulkLabelEntriesInput = z.infer<typeof bulkLabelEntriesInputSchema>;

/**
 * What a bulk operation did, for `[LOG-03]`'s toast.
 *
 * `affected` is reported rather than assumed equal to `entryIds.length`, even though the routes
 * refuse a selection that does not resolve completely. The toast names a count to the user
 * (*"n entries deleted"*), and a count the client derived from its own request is a count that
 * cannot be wrong — including when it is.
 */
export const bulkEntryResultSchema = z.object({
  affected: z.number().int().nonnegative(),
});
export type BulkEntryResult = z.infer<typeof bulkEntryResultSchema>;

/**
 * `[OVL-27]`'s result — the toast is `3 entries copied to Coorg Trip · 3 new labels`, so the label
 * count has to come back.
 *
 * **The two lists are separate rather than one `createdLabels`** because they are created in two
 * different fields of the destination and the undo removes them from two different arrays; a merged
 * list would have to be re-split by looking each name up again, and a name legitimately present in
 * both (`Cash` is a payment mode and could be a category) would re-split wrongly.
 *
 * `droppedCustomValues` counts entries whose `customValues` did not survive the transfer — the
 * user's decision of 2026-08-14, and `[OVL-27]`'s copy discloses it. Zero for every book that does
 * not use custom fields, which is the common case.
 */
export const bulkTransferEntriesResultSchema = bulkEntryResultSchema.extend({
  createdCategories: z.array(z.string()),
  createdPaymentModes: z.array(z.string()),
  droppedCustomValues: z.number().int().nonnegative(),
});
export type BulkTransferEntriesResult = z.infer<typeof bulkTransferEntriesResultSchema>;

/**
 * `[OVL-26]`'s result. The toast is `10 entries set to RuPay · new payment mode`, and the trailing
 * clause appears only when the label was created by this request — which the server decided, so the
 * server is what reports it.
 */
export const bulkLabelEntriesResultSchema = bulkEntryResultSchema.extend({
  createdLabel: z.boolean(),
});
export type BulkLabelEntriesResult = z.infer<typeof bulkLabelEntriesResultSchema>;
