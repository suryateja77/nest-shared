import { describe, expect, it } from 'vitest';
import {
  dateOnlyString,
  isoDateString,
  localDateTimeString,
  MAX_ENTRY_AMOUNT,
  moneyAmount,
  moneyTotal,
  signedMoneyAmount,
  signedMoneyTotal,
  timeOfDayString,
} from './common.js';
import { accountSchema, accountSummarySchema, createAccountInputSchema } from './account.js';
import {
  bookSchema,
  bookStatsSchema,
  createBookInputSchema,
  customFieldTypeSchema,
} from './book.js';
import { createEntryInputSchema, entrySchema, updateEntryInputSchema } from './entry.js';
import { createDueInputSchema, dueSchema } from './due.js';
import {
  createReminderInputSchema,
  reminderRepeatSchema,
  reminderSchema,
  reminderStatusSchema,
} from './reminder.js';
import {
  CAPABILITY_ORDER,
  OWNER_PERMISSIONS,
  ROLE_PERMISSION_SEED,
  assignableRoleSchema,
  permissionsSchema,
  roleSchema,
  rolePermissionsSchema,
} from './role.js';
import { createInviteInputSchema } from './invite.js';

const OID = '507f1f77bcf86cd799439011';

describe('common temporal formats', () => {
  it('accepts a calendar date and rejects an impossible one', () => {
    expect(dateOnlyString.safeParse('2026-07-31').success).toBe(true);
    expect(dateOnlyString.safeParse('2026-02-30').success).toBe(false);
    expect(dateOnlyString.safeParse('2026-7-1').success).toBe(false);
  });

  it('accepts a zone-less wall-clock date-time and rejects an offset', () => {
    // [LOG-01] gives Reminder.due as 'YYYY-MM-DDTHH:mm' — deliberately zone-less.
    expect(localDateTimeString.safeParse('2026-08-01T08:00').success).toBe(true);
    expect(localDateTimeString.safeParse('2026-08-01T08:00:00Z').success).toBe(false);
    expect(localDateTimeString.safeParse('2026-08-01').success).toBe(false);
  });

  it('requires an instant to carry a zone', () => {
    expect(isoDateString.safeParse('2026-07-31T21:41:00.000Z').success).toBe(true);
    expect(isoDateString.safeParse('2026-07-31T21:41:00+05:30').success).toBe(true);
    // Date.parse alone would accept both of these as a timestamp.
    expect(isoDateString.safeParse('2026-07-31').success).toBe(false);
    expect(isoDateString.safeParse('2026-07-31T21:41').success).toBe(false);
  });
});

describe('moneyAmount', () => {
  it('is whole rupees and never negative', () => {
    expect(moneyAmount.safeParse(2480).success).toBe(true);
    expect(moneyAmount.safeParse(0).success).toBe(true);
    expect(moneyAmount.safeParse(24.5).success).toBe(false);
    expect(moneyAmount.safeParse(-100).success).toBe(false);
  });

  it('caps a single entered amount at MAX_ENTRY_AMOUNT', () => {
    // Without a ceiling, one entry of MAX_SAFE_INTEGER pushes a book's summed `cin` out of the
    // safe-integer range, and bookStatsSchema then rejects it during response serialization — every
    // balance screen 500s for every member of the account, with no delete route to undo it.
    expect(moneyAmount.safeParse(MAX_ENTRY_AMOUNT).success).toBe(true);
    expect(moneyAmount.safeParse(MAX_ENTRY_AMOUNT + 1).success).toBe(false);
    expect(moneyAmount.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    expect(signedMoneyAmount.safeParse(-MAX_ENTRY_AMOUNT - 1).success).toBe(false);
  });

  it('does not apply the single-entry ceiling to a derived total', () => {
    // cin/cout/bal are sums over a whole ledger. A household book passes ₹1 crore of lifetime
    // cash-in without anything unusual happening, so capping totals would reject an ordinary book.
    expect(moneyTotal.safeParse(MAX_ENTRY_AMOUNT * 5000).success).toBe(true);
    expect(signedMoneyTotal.safeParse(-MAX_ENTRY_AMOUNT * 5000).success).toBe(true);
    expect(
      bookStatsSchema.safeParse({ cin: 9_00_00_00_000, cout: 0, bal: 9_00_00_00_000 }).success,
    ).toBe(true);
  });

  it('still refuses a total that has left the safe-integer range', () => {
    // The backstop the entry cap makes unreachable rather than one request away.
    expect(moneyTotal.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
  });
});

describe('createBookInputSchema', () => {
  const validBook = {
    accountId: OID,
    name: 'Household',
    sub: 'Runs since Jan 2026',
    tint: '#B4472C',
    opening: 60000,
    categories: ['Groceries'],
    paymentModes: ['UPI'],
    customFields: [],
    useCategory: true,
    useMode: true,
    useAttach: false,
  };

  it('accepts a valid book payload', () => {
    expect(createBookInputSchema.safeParse(validBook).success).toBe(true);
  });

  it('rejects a non-hex tint', () => {
    expect(createBookInputSchema.safeParse({ ...validBook, tint: 'orange' }).success).toBe(false);
  });

  it('requires the entry-field toggles that [OVL-08] reads', () => {
    const withoutToggle: Record<string, unknown> = { ...validBook };
    delete withoutToggle.useCategory;
    expect(createBookInputSchema.safeParse(withoutToggle).success).toBe(false);
  });

  it('allows a negative opening balance', () => {
    expect(createBookInputSchema.safeParse({ ...validBook, opening: -5000 }).success).toBe(true);
  });

  it('offers exactly the two custom-field types from [LOG-01]', () => {
    expect(customFieldTypeSchema.options).toEqual(['text', 'toggle']);
  });

  it('rejects duplicate categories and payment modes', () => {
    // [LOG-05] groups cash-out byCat/byMode — a duplicate silently splits one total into two.
    expect(
      createBookInputSchema.safeParse({ ...validBook, categories: ['Food', 'Food'] }).success,
    ).toBe(false);
    expect(
      createBookInputSchema.safeParse({ ...validBook, paymentModes: ['UPI', 'UPI'] }).success,
    ).toBe(false);
  });

  it('rejects duplicate custom-field ids that entry customValues key off', () => {
    const field = { id: OID, name: 'Bill No.', type: 'text' as const };
    expect(
      createBookInputSchema.safeParse({ ...validBook, customFields: [field, { ...field }] })
        .success,
    ).toBe(false);
  });

  it('is derivable — the uniqueness checks sit on the arrays, not the object', () => {
    // zod refuses .pick()/.omit() on an object carrying refinements; bookSchema must stay derivable.
    expect(() => bookSchema.omit({ id: true })).not.toThrow();
  });
});

describe('createEntryInputSchema', () => {
  const validEntry = {
    bookId: OID,
    type: 'out' as const,
    amount: 2480,
    remark: 'Monthly stock-up, D-Mart',
    date: '2026-07-31',
    time: '18:42',
  };

  it('accepts a valid entry payload', () => {
    expect(createEntryInputSchema.safeParse(validEntry).success).toBe(true);
  });

  it('rejects a negative amount', () => {
    expect(createEntryInputSchema.safeParse({ ...validEntry, amount: -100 }).success).toBe(false);
  });

  it('stores time as 24-hour HH:mm, never the display token', () => {
    // '6:42 PM' is [LOG-06]'s timeTok — display only. Asserted on the field, since the create
    // input strips time entirely (the server stamps it).
    expect(timeOfDayString.safeParse('18:42').success).toBe(true);
    expect(timeOfDayString.safeParse('6:42 PM').success).toBe(false);
  });

  it('does not accept a client-supplied createdBy', () => {
    const parsed = createEntryInputSchema.parse({ ...validEntry, createdBy: OID });
    expect(parsed).not.toHaveProperty('createdBy');
  });

  it('does not accept a client-supplied bookId', () => {
    // The book is the `:bookId` the server already resolved and authorized. A body copy would be a
    // second, independent claim about which book is being written to — `nest-authz`'s "trusting
    // bookId from the body on create". zod strips unknown keys, so this asserts the *result*.
    const parsed = createEntryInputSchema.parse(validEntry);
    expect(parsed).not.toHaveProperty('bookId');
    expect(updateEntryInputSchema.parse({ bookId: OID })).not.toHaveProperty('bookId');
  });

  it('does not accept a client-supplied date or time', () => {
    // [OVL-08] has no date picker; the prototype stamps the clock and preserves both on edit.
    const created = createEntryInputSchema.parse(validEntry);
    expect(created).not.toHaveProperty('date');
    expect(created).not.toHaveProperty('time');
    const updated = updateEntryInputSchema.parse({ date: '2026-01-01', time: '10:00' });
    expect(updated).not.toHaveProperty('date');
    expect(updated).not.toHaveProperty('time');
  });

  it('rejects customValues keyed by anything but a custom-field id', () => {
    const result = createEntryInputSchema.safeParse({
      ...validEntry,
      customValues: { 'Bill No.': 'DM/26/44812' },
    });
    expect(result.success).toBe(false);
  });

  it('carries toggle custom values as booleans', () => {
    const result = createEntryInputSchema.safeParse({
      ...validEntry,
      customValues: { [OID]: true, [`${OID.slice(0, 23)}2`]: 'DM/26/44812' },
    });
    expect(result.success).toBe(true);
  });

  it('keeps createdBy on the full entity', () => {
    expect(entrySchema.shape.createdBy).toBeDefined();
  });
});

describe('createDueInputSchema', () => {
  const validDue = {
    accountId: OID,
    direction: 'lent' as const,
    personName: 'Nikhil Sharma',
    amount: 15000,
    on: '2026-07-12',
    back: '2026-08-12',
    reminderRepeat: 'none' as const,
  };

  it('defaults remindMe to false', () => {
    expect(createDueInputSchema.parse(validDue).remindMe).toBe(false);
  });

  it('accepts a null return date — [LOG-09] deletes any linked reminder in that case', () => {
    expect(createDueInputSchema.safeParse({ ...validDue, back: null }).success).toBe(true);
  });

  it('keeps `on` and `back` as separate dates', () => {
    const parsed = createDueInputSchema.parse(validDue);
    expect(parsed.on).toBe('2026-07-12');
    expect(parsed.back).toBe('2026-08-12');
  });

  it('does not accept a client-supplied reminderId', () => {
    const parsed = createDueInputSchema.parse({ ...validDue, reminderId: OID });
    expect(parsed).not.toHaveProperty('reminderId');
  });

  it('tracks settledOn on the full entity', () => {
    expect(dueSchema.shape.settledOn).toBeDefined();
  });
});

describe('createReminderInputSchema', () => {
  const validReminder = {
    accountId: OID,
    title: 'Apartment maintenance',
    due: '2026-08-10T09:00',
    amount: 4800,
    bookId: OID,
    repeat: 'quarterly' as const,
    notifyBefore: '2-days' as const,
  };

  it('accepts a valid reminder payload', () => {
    expect(createReminderInputSchema.safeParse(validReminder).success).toBe(true);
  });

  it('rejects a malformed due', () => {
    expect(createReminderInputSchema.safeParse({ ...validReminder, due: '9:00' }).success).toBe(
      false,
    );
  });

  it('supports quarterly — [REQ-6] names maintenance as the quarterly case', () => {
    expect(reminderRepeatSchema.options).toContain('quarterly');
  });

  it('supports the snoozed status and its filter chip on [SCR-10]', () => {
    expect(reminderStatusSchema.options).toEqual(['upcoming', 'snoozed', 'done']);
  });

  it('allows a reminder with no amount and no book', () => {
    const result = createReminderInputSchema.safeParse({
      ...validReminder,
      amount: null,
      bookId: null,
    });
    expect(result.success).toBe(true);
  });

  it('does not accept client-supplied status, snoozeTill, logs or dueId', () => {
    const parsed = createReminderInputSchema.parse({
      ...validReminder,
      status: 'done',
      snoozeTill: '2026-08-10T22:30',
      logs: [],
      dueId: OID,
    });
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('snoozeTill');
    expect(parsed).not.toHaveProperty('logs');
    expect(parsed).not.toHaveProperty('dueId');
  });

  it('keeps the done-history and the dues back-reference on the full entity', () => {
    expect(reminderSchema.shape.logs).toBeDefined();
    expect(reminderSchema.shape.dueId).toBeDefined();
    expect(reminderSchema.shape.snoozeTill).toBeDefined();
  });
});

describe('permissions', () => {
  it('requires all six capability flags', () => {
    expect(permissionsSchema.safeParse({ viewEntries: true }).success).toBe(false);
  });

  it('fixes the capability order from [LOG-01]', () => {
    expect(CAPABILITY_ORDER).toEqual([
      'viewEntries',
      'addEntries',
      'editAnyEntry',
      'deleteEntries',
      'manageMembers',
      'bookSettings',
    ]);
  });

  it('rejects a matrix missing a role', () => {
    // A partial matrix would leave a role with undefined capabilities at authorization time.
    const partial = { ADMIN: ROLE_PERMISSION_SEED.ADMIN };
    expect(rolePermissionsSchema.safeParse(partial).success).toBe(false);
  });

  it('keys the editable matrix on the four chips [SCR-08] renders', () => {
    expect(assignableRoleSchema.options).toEqual(['ADMIN', 'EDITOR', 'VIEWER', 'TEEN']);
    expect(rolePermissionsSchema.safeParse(ROLE_PERMISSION_SEED).success).toBe(true);
  });

  it('gives OWNER the same six capabilities as the seeded ADMIN', () => {
    expect(roleSchema.options).toContain('OWNER');
    expect(OWNER_PERMISSIONS).toEqual(ROLE_PERMISSION_SEED.ADMIN);
  });

  it('keeps OWNER out of the editable matrix so its rights cannot be stripped', () => {
    const withOwner = { ...ROLE_PERMISSION_SEED, OWNER: OWNER_PERMISSIONS };
    expect(rolePermissionsSchema.safeParse(withOwner).success).toBe(false);
  });

  describe('exactly one OWNER', () => {
    const member = (role: string) => ({
      userId: OID,
      name: 'Ananya Sharma',
      contact: 'ananya@gmail.com',
      role,
    });
    const base = {
      id: OID,
      name: 'Sharma Family',
      kind: 'SHARED',
      initial: 'S',
      permissions: ROLE_PERMISSION_SEED,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };

    it('accepts an account with one owner alongside other roles', () => {
      const members = [member('OWNER'), member('ADMIN'), member('VIEWER')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(true);
    });

    it('rejects an account with no owner', () => {
      // Deliberately rejects the prototype's shared-account fixture (two ADMINs, no owner):
      // without an owner, toggling Manage members off the ADMIN row on [SCR-08] bricks the account.
      const members = [member('ADMIN'), member('ADMIN'), member('EDITOR')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(false);
    });

    it('rejects an account with two owners', () => {
      const members = [member('OWNER'), member('OWNER')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(false);
    });

    it('does not let a client set members or permissions at creation', () => {
      const parsed = createAccountInputSchema.parse({
        name: 'My Money',
        kind: 'PERSONAL',
        initial: 'A',
        members: [member('ADMIN')],
        permissions: ROLE_PERMISSION_SEED,
      });
      expect(parsed).not.toHaveProperty('members');
      expect(parsed).not.toHaveProperty('permissions');
    });
  });

  it('does not let an invite confer OWNER', () => {
    const asAdmin = createInviteInputSchema.safeParse({ contact: 'a@b.com', role: 'ADMIN' });
    const asOwner = createInviteInputSchema.safeParse({ contact: 'a@b.com', role: 'OWNER' });
    expect(asAdmin.success).toBe(true);
    expect(asOwner.success).toBe(false);
  });

  it('seeds the [LOG-01] matrix', () => {
    expect(rolePermissionsSchema.safeParse(ROLE_PERMISSION_SEED).success).toBe(true);
    expect(ROLE_PERMISSION_SEED.EDITOR.deleteEntries).toBe(false);
    expect(ROLE_PERMISSION_SEED.TEEN.addEntries).toBe(true);
    expect(ROLE_PERMISSION_SEED.TEEN.editAnyEntry).toBe(false);
    expect(ROLE_PERMISSION_SEED.VIEWER.addEntries).toBe(false);
  });
});

describe('accountSummarySchema', () => {
  const summary = {
    id: OID,
    name: 'Sharma Family',
    kind: 'SHARED' as const,
    initial: 'S',
    members: [{ userId: OID, name: 'Ananya Sharma', role: 'OWNER' as const }],
    myCapabilities: OWNER_PERMISSIONS,
    stats: { cin: 120000, cout: 37480, bal: 82520 },
    bookCount: 3,
  };

  it('accepts the account-list shape', () => {
    expect(accountSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('withholds every member contact', () => {
    // A member's phone or email renders on [SCR-08] alone — the manageMembers screen. The account
    // list must not carry it, or drawing [SCR-05]'s avatars hands a TEEN everyone's contact details.
    const parsed = accountSummarySchema.parse({
      ...summary,
      members: [{ ...summary.members[0], contact: 'ananya@gmail.com' }],
    });
    expect(parsed.members[0]).not.toHaveProperty('contact');
  });

  it('withholds the editable permissions matrix and carries resolved capabilities instead', () => {
    // nest-authz: the client mirrors the server's answer, it never re-derives it from the matrix.
    const parsed = accountSummarySchema.parse({
      ...summary,
      permissions: ROLE_PERMISSION_SEED,
    });
    expect(parsed).not.toHaveProperty('permissions');
    expect(permissionsSchema.safeParse(parsed.myCapabilities).success).toBe(true);
  });

  it('represents an OWNER member, which the four assignable chips cannot', () => {
    // Every account has exactly one OWNER, so the member projection needs the full role enum.
    expect(assignableRoleSchema.safeParse('OWNER').success).toBe(false);
    expect(accountSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('distinguishes "not allowed to see a balance" from "no books"', () => {
    // stats is null exactly when the caller lacks viewEntries. GET /accounts has no capability
    // gate — you must find the accounts you belong to regardless — so the balance is gated here.
    const withheld = accountSummarySchema.parse({ ...summary, stats: null });
    expect(withheld.stats).toBeNull();
    expect(withheld.bookCount).toBe(3);

    const empty = accountSummarySchema.parse({
      ...summary,
      stats: { cin: 0, cout: 0, bal: 0 },
      bookCount: 0,
    });
    expect(empty.stats).not.toBeNull();
  });

  it('requires stats to be present-or-null, never absent', () => {
    // An absent key would collapse "withheld" back into "missing", which is what null exists to
    // keep apart — the same reasoning as `nextCursor` in http.ts.
    const withoutStats: Record<string, unknown> = { ...summary };
    delete withoutStats.stats;
    expect(accountSummarySchema.safeParse(withoutStats).success).toBe(false);
  });
});
