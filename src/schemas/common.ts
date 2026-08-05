import { z } from 'zod';

/** MongoDB ObjectId, as a 24-char hex string. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId');

/**
 * ISO 8601 **instant**, for server-owned timestamps.
 *
 * A zone designator is required, which is what makes this an instant rather than a wall-clock
 * reading. `Date.parse` alone is too lenient to express that: it accepts `'2026-07-31'` and other
 * implementation-defined forms, so a date-only string would silently pass as a timestamp.
 *
 * Use this only for true points in time (`createdAt`, `updatedAt`, a reminder log's `at`).
 * User-facing dates and times are wall-clock — see `dateOnlyString` and `localDateTimeString`.
 */
export const isoDateString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/,
    'Expected an ISO 8601 instant with a zone, e.g. 2026-07-31T21:41:00.000Z',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid ISO date-time string');

/**
 * Calendar date, `YYYY-MM-DD`. The ledger groups entries by this value ([SCR-06]) and dues use it
 * for `on` / `back` / `settledOn` ([LOG-01]).
 *
 * Checked against the calendar so `2026-02-30` is rejected rather than silently rolling over.
 */
export const dateOnlyString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'Not a real calendar date');

/**
 * Calendar month, `YYYY-MM`.
 *
 * Month-scoped figures are requested by the client rather than inferred by the server: "this month"
 * is a local-calendar fact, and no account or user timezone is defined yet (see [GAP-5]). Having
 * the client name the month removes the guess instead of hiding it.
 */
export const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

/** Time of day, 24-hour `HH:mm`. `9:41 PM` is a display format ([LOG-06] timeTok), never storage. */
export const timeOfDayString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm in 24-hour time');

/**
 * Local wall-clock date-time, `YYYY-MM-DDTHH:mm`, with no zone or offset — the shape [LOG-01] gives
 * `Reminder.due`, `Reminder.snoozeTill` and the `dueWas` in a reminder's log.
 *
 * Deliberately zone-less: "rent is due on the 1st at 08:00" is a wall-clock fact, and `bumpDue`
 * ([LOG-08]) advances it by calendar units, not by elapsed milliseconds. Resolving one of these to
 * an instant for push delivery needs an account or user timezone, which the design does not yet
 * define — see [GAP-5]. Do not add an offset here to work around that.
 */
export const localDateTimeString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Expected YYYY-MM-DDTHH:mm')
  .refine(
    (value) => dateOnlyString.safeParse(value.slice(0, 10)).success,
    'Not a real calendar date',
  );

/**
 * The largest a **single entered amount** may be: ₹1,00,00,000.
 *
 * A ceiling has to exist, and not for tidiness. Derived totals are re-validated on the way out
 * (`bookStatsSchema`), and zod's `.int()` rejects anything past `Number.MAX_SAFE_INTEGER` — so
 * without a bound here one member with `addEntries` could post `MAX_SAFE_INTEGER`, push a book's
 * summed `cin` out of the safe-integer range, and make `[SCR-04]`, `[SCR-05]` and `[SCR-06]` fail
 * serialization for **every** member of the account, with no edit or delete route to undo it.
 *
 * ₹1 crore because it is inside what the frozen design can render — `[LOG-06]`'s `compact()` gives
 * "1 Cr" and `words()` "1 CRORE" — while still covering a legitimately large one-off for a family.
 */
export const MAX_ENTRY_AMOUNT = 10_000_000;

/**
 * A money amount in **whole rupees**, never negative — direction is a separate field (`Entry.type`,
 * `Due.direction`).
 *
 * Integer because the frozen design never renders paise: `inr()` groups whole digits, `words()`
 * reads "RUPEES 12,340", `compact()` tops out at "1.25 Cr", and every seeded amount in the
 * prototype is whole ([LOG-06], [DS-6]). Integers also keep `bal = opening + cin − cout` exact over
 * a long ledger, which float rupees would not.
 *
 * **For a value a person enters** — an entry's amount, a due's amount, a book's opening balance.
 * Sums of these are `moneyTotal`, which is bounded far more loosely on purpose.
 */
export const moneyAmount = z
  .number()
  .int('Amounts are whole rupees')
  .nonnegative()
  .max(MAX_ENTRY_AMOUNT, 'That is larger than a single entry may be');

/** A signed entered amount, for values that may legitimately go below zero (a book's opening balance). */
export const signedMoneyAmount = z
  .number()
  .int('Amounts are whole rupees')
  .min(-MAX_ENTRY_AMOUNT, 'That is larger than a single entry may be')
  .max(MAX_ENTRY_AMOUNT, 'That is larger than a single entry may be');

/**
 * A **derived total** — `cin`, `cout`, `bal`, `monthNet`, dues totals ([LOG-05]).
 *
 * Deliberately not bounded by `MAX_ENTRY_AMOUNT`: these are sums over an entire ledger, and a
 * household book passes ₹1 crore of lifetime cash-in without anything unusual happening. Applying
 * the single-entry ceiling here would reject a perfectly ordinary book.
 *
 * The only bound is `.int()`'s safe-integer range, which with entries capped at ₹1 crore needs
 * something on the order of 10^9 entries in one book to reach — unreachable rather than one
 * request away, which is the whole point of the entry cap.
 */
export const moneyTotal = z.number().int('Amounts are whole rupees').nonnegative();

/** A signed derived total — a balance may legitimately be negative. */
export const signedMoneyTotal = z.number().int('Amounts are whole rupees');

export const timestampsSchema = z.object({
  createdAt: isoDateString,
  updatedAt: isoDateString,
});
