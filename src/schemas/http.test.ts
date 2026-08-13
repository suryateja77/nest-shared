import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  apiErrorSchema,
  errorCodeSchema,
  paginated,
  paginationQuerySchema,
} from './http.js';
import { bookSummarySchema, booksQuerySchema } from './book.js';
import { entriesPageSchema } from './entry.js';
import { monthString } from './common.js';

const OID = '507f1f77bcf86cd799439011';

describe('error contract', () => {
  it('carries a machine-readable code the client can branch on', () => {
    const parsed = apiErrorSchema.parse({
      error: { code: 'NOT_FOUND', message: 'That book could not be found.' },
    });
    expect(parsed.error.code).toBe('NOT_FOUND');
  });

  it('rejects an unknown code rather than letting it reach a switch', () => {
    expect(apiErrorSchema.safeParse({ error: { code: 'OOPS', message: 'x' } }).success).toBe(false);
  });

  it('carries field issues shaped for react-hook-form', () => {
    const parsed = apiErrorSchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Check the highlighted fields.',
        details: [{ path: ['amount'], message: 'Amounts are whole rupees' }],
      },
    });
    expect(parsed.error.details?.[0]?.path).toEqual(['amount']);
  });

  it('separates FORBIDDEN from NOT_FOUND', () => {
    // Cross-tenant reads return NOT_FOUND so the API never confirms a resource exists.
    expect(errorCodeSchema.options).toContain('FORBIDDEN');
    expect(errorCodeSchema.options).toContain('NOT_FOUND');
  });
});

describe('pagination', () => {
  it('defaults the page size and caps it', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('coerces limit from a query string', () => {
    expect(paginationQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('wraps a list as { items, nextCursor }', () => {
    const page = paginated(z.object({ id: z.string() }));
    const parsed = page.parse({ items: [{ id: 'a' }], nextCursor: 'abc' });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBe('abc');
  });

  it('requires nextCursor to be explicitly null on the last page', () => {
    const page = paginated(z.object({ id: z.string() }));
    // Absent would be indistinguishable from a malformed response.
    expect(page.safeParse({ items: [] }).success).toBe(false);
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });

  it('applies the envelope to entries', () => {
    expect(entriesPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
});

describe('month scoping', () => {
  it('accepts YYYY-MM and rejects a bad month', () => {
    expect(monthString.safeParse('2026-07').success).toBe(true);
    expect(monthString.safeParse('2026-13').success).toBe(false);
    expect(monthString.safeParse('2026-7').success).toBe(false);
    expect(monthString.safeParse('2026-07-31').success).toBe(false);
  });

  it('requires the client to name the month for the books list', () => {
    // The server has no defensible default without a timezone ([GAP-5]).
    expect(booksQuerySchema.safeParse({}).success).toBe(false);
    expect(booksQuerySchema.safeParse({ month: '2026-07' }).success).toBe(true);
  });
});

describe('bookSummarySchema — derived, never stored [LOG-05]', () => {
  const summary = {
    id: OID,
    accountId: OID,
    name: 'Household',
    tint: '#B4472C',
    /** `[LOG-17]`'s `isBookCreator` — `[SCR-07]` cannot render its admin rows without it. */
    createdBy: OID,
    opening: 60000,
    categories: ['Groceries'],
    paymentModes: ['UPI'],
    customFields: [],
    useCategory: true,
    useMode: true,
    useAttach: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    stats: { cin: 85000, cout: 3120, bal: 141880 },
    entryCount: 42,
    monthNet: 81880,
    accountName: 'Sharma Family',
    month: '2026-07',
    /** `[OVL-18]`'s header meta — `10 ENTRIES · ₹99,621 · 4 MEMBERS`. */
    memberCount: 4,
    /**
     * Per-book now that `[GAP-2]` is built: two books in one account can grant the same person
     * different capabilities, so the answer travels with the book rather than with the account.
     */
    myCapabilities: {
      viewEntries: true,
      addEntries: true,
      editAnyEntry: true,
      deleteEntries: false,
      manageMembers: false,
      bookSettings: false,
    },
  };

  it('carries the figures [SCR-05] renders', () => {
    expect(bookSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('allows a negative balance and a negative month net', () => {
    const inRed = { ...summary, stats: { cin: 0, cout: 5000, bal: -5000 }, monthNet: -5000 };
    expect(bookSummarySchema.safeParse(inRed).success).toBe(true);
  });

  it('keeps cin and cout non-negative — direction is the entry type, not the sign', () => {
    const bad = { ...summary, stats: { ...summary.stats, cin: -1 } };
    expect(bookSummarySchema.safeParse(bad).success).toBe(false);
  });

  it('echoes the month so a delta cannot be misattributed', () => {
    expect(bookSummarySchema.parse(summary).month).toBe('2026-07');
    const withoutMonth: Record<string, unknown> = { ...summary };
    delete withoutMonth.month;
    expect(bookSummarySchema.safeParse(withoutMonth).success).toBe(false);
  });
});
