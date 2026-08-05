import { z } from 'zod';
import {
  dateOnlyString,
  moneyAmount,
  objectId,
  timeOfDayString,
  timestampsSchema,
} from './common.js';
import { paginated, paginationQuerySchema } from './http.js';

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
    customValues: z.record(objectId, z.union([z.string(), z.boolean()])).optional(),
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
 * `GET /books/:bookId/entries` — the ledger ([SCR-06]).
 *
 * Ordered `date desc, time desc, id desc`, newest first, which is both what the screen renders and
 * what makes the running balance computable client-side: any row's balance is the book balance
 * minus everything newer, and everything newer is already loaded by the time you have scrolled to
 * it ([LOG-05]).
 *
 * Filters ([OVL-04]) are not part of this contract yet — they are excluded from the first slice.
 */
export const entriesQuerySchema = paginationQuerySchema;
export type EntriesQuery = z.infer<typeof entriesQuerySchema>;

/** `{ items, nextCursor }` of entries. */
export const entriesPageSchema = paginated(entrySchema);
export type EntriesPage = z.infer<typeof entriesPageSchema>;
