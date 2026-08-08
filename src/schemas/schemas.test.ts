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
  bookBaseSchema,
  bookSchema,
  bookStatsSchema,
  createBookInputSchema,
  customFieldTypeSchema,
  updateBookInputSchema,
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
  ROLE_PERMISSION_SEED,
  permissionsSchema,
  roleSchema,
  rolePermissionsSchema,
} from './role.js';
import { createInviteInputSchema } from './invite.js';
import { updateProfileDetailsInputSchema } from './profile.js';
import {
  PASSWORD_MAX_LENGTH,
  sendOtpInputSchema,
  signInInputSchema,
  signUpInputSchema,
  verifyOtpInputSchema,
} from './auth.js';

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
  /** A second, genuinely different id — reusing `OID` would make the negative cases pass by accident. */
  const OTHER_MEMBER = '507f1f77bcf86cd799439013';
  const validBook = {
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

  it('does not accept a client-supplied accountId', () => {
    // The account is the `:accountId` the server already resolved and authorized. A body copy is a
    // second, independent claim — the same defect createEntryInputSchema carried for bookId.
    const parsed = createBookInputSchema.parse({ ...validBook, accountId: OID });
    expect(parsed).not.toHaveProperty('accountId');
    expect(updateBookInputSchema.parse({ accountId: OID })).not.toHaveProperty('accountId');
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

  it('is derivable from the base — the uniqueness checks sit on the arrays, not the object', () => {
    // zod refuses .pick()/.omit() on an object carrying refinements, so the derivable shape has to
    // be the *base*: `bookSchema` itself now carries the creator-is-a-member refinement, and every
    // input and response schema is cut from `bookBaseSchema` for exactly that reason.
    expect(() => bookBaseSchema.omit({ id: true })).not.toThrow();
    // The array-level uniqueness checks are what this test was written to pin, and they still do
    // not block derivation — they sit on `categories`/`paymentModes`/`customFields`, not the object.
    expect(() => bookBaseSchema.omit({ categories: true, customFields: true })).not.toThrow();
  });

  it('refuses a book whose creator is not one of its members', () => {
    // [OVL-09] locks the creator's own row on ("YOU · ALWAYS HAS ACCESS"). Without this, [LOG-17]
    // leaves a creator who can administer a book (Move/Archive/Delete) but cannot see it.
    const base = {
      ...validBook,
      id: OID,
      accountId: OID,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(bookSchema.safeParse({ ...base, createdBy: OID, members: [OID] }).success).toBe(true);
    expect(
      bookSchema.safeParse({ ...base, createdBy: OID, members: [OTHER_MEMBER] }).success,
    ).toBe(false);
    expect(bookSchema.safeParse({ ...base, createdBy: OID, members: [] }).success).toBe(false);
  });

  it('keeps members out of the update input — bulk membership edits are undesigned', () => {
    // The only two designed mutations are [OVL-09]'s initial set and a self-only Leave book
    // ([OVL-17]); adding a member back is [GAP-2]. A general update must not express either.
    expect(updateBookInputSchema.parse({ members: [OID] })).not.toHaveProperty('members');
  });

  it('defaults members to empty, since [OVL-09] renders no picker in a one-member account', () => {
    expect(createBookInputSchema.parse(validBook).members).toEqual([]);
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

  it('keys the matrix on the four chips [SCR-08] renders, which is every role there is', () => {
    // Ownership is `Account.createdBy`, not a role ([LOG-01] glossary), so no role sits outside
    // the matrix and there is no second "assignable" enum to keep in step with this one.
    expect(roleSchema.options).toEqual(['ADMIN', 'EDITOR', 'VIEWER', 'TEEN']);
    expect(rolePermissionsSchema.safeParse(ROLE_PERMISSION_SEED).success).toBe(true);
  });

  it('has no OWNER role', () => {
    // The revised [LOG-01] gives Member.role as ADMIN|EDITOR|VIEWER|TEEN and the handoff glossary
    // is explicit that owner "is not a role in CAPS". A stored member cannot hold one.
    expect(roleSchema.safeParse('OWNER').success).toBe(false);
  });

  describe('the creator is always a member', () => {
    const CREATOR = OID;
    /** Must differ from `OID` — a same-value "other" member silently satisfies the refinement. */
    const OTHER = '507f1f77bcf86cd799439012';
    const member = (userId: string, role: string) => ({
      userId,
      name: 'Ananya Sharma',
      contact: 'ananya@gmail.com',
      role,
    });
    const base = {
      id: OID,
      name: 'Sharma Family',
      kind: 'SHARED',
      initial: 'S',
      createdBy: CREATOR,
      permissions: ROLE_PERMISSION_SEED,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };

    it('accepts an account whose creator is among its members', () => {
      const members = [member(CREATOR, 'ADMIN'), member(OTHER, 'VIEWER')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(true);
    });

    it('accepts two ADMINs, which the old OWNER model rejected', () => {
      // The prototype's own shared-account fixture is two ADMINs; under createdBy they are
      // distinguished by who created the account, not by holding a different role.
      const members = [member(CREATOR, 'ADMIN'), member(OTHER, 'ADMIN')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(true);
    });

    it('rejects an account whose creator is not a member', () => {
      // Nobody could then administer it — [LOG-16] gates every account action on isCreator, so a
      // creator outside members[] is the same brick the old exactly-one-OWNER rule prevented.
      const members = [member(OTHER, 'ADMIN')];
      expect(accountSchema.safeParse({ ...base, members }).success).toBe(false);
    });

    it('does not let a client set createdBy, members or permissions at creation', () => {
      const parsed = createAccountInputSchema.parse({
        name: 'My Money',
        kind: 'PERSONAL',
        initial: 'A',
        createdBy: OTHER,
        members: [member(OTHER, 'ADMIN')],
        permissions: ROLE_PERMISSION_SEED,
      });
      expect(parsed).not.toHaveProperty('createdBy');
      expect(parsed).not.toHaveProperty('members');
      expect(parsed).not.toHaveProperty('permissions');
    });
  });

  it('trims the account name so a whitespace-only one cannot be created', () => {
    // [OVL-17]'s delete confirm unlocks on dangerText.trim() === account.name.trim(). A name of
    // spaces would make an empty input satisfy the gate that exists to slow a deletion down.
    expect(
      createAccountInputSchema.safeParse({ name: '   ', kind: 'SHARED', initial: 'S' }).success,
    ).toBe(false);

    const parsed = createAccountInputSchema.parse({
      name: '  PG Rent  ',
      kind: 'SHARED',
      initial: 'P',
    });
    expect(parsed.name).toBe('PG Rent');
  });

  it('requires an invite contact to be a phone number or an email', () => {
    // contactKeyOf strips non-digits when it sees no '@', so free text normalises to a key that can
    // match a real person while `contact` — which [SCR-08] renders verbatim — keeps the whole string.
    const invite = (contact: string) =>
      createInviteInputSchema.safeParse({ contact, role: 'EDITOR' }).success;

    expect(invite('9876543210')).toBe(true);
    expect(invite('+91 98450 22118')).toBe(true);
    expect(invite('someone@example.com')).toBe(true);

    expect(invite('7')).toBe(false);
    expect(invite('9876543210 — overdue, pay at nest-billing.example')).toBe(false);
    expect(invite('not-an-email@')).toBe(false);
  });

  it('accepts every role on an invite and nothing else', () => {
    // [OVL-15]'s THEY JOIN AS pills. An invite confers a role, never ownership — createdBy is set
    // at creation and never changes ([LOG-16]), so no value here escalates into administering.
    for (const role of roleSchema.options) {
      expect(createInviteInputSchema.safeParse({ contact: 'a@b.com', role }).success).toBe(true);
    }
    expect(createInviteInputSchema.safeParse({ contact: 'a@b.com', role: 'OWNER' }).success).toBe(
      false,
    );
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
    createdBy: OID,
    members: [{ userId: OID, name: 'Ananya Sharma', role: 'ADMIN' as const }],
    myCapabilities: ROLE_PERMISSION_SEED.ADMIN,
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

  it('carries createdBy, which myCapabilities cannot stand in for', () => {
    // [LOG-16]: a non-creating ADMIN holds identical capabilities to the creator under the seeded
    // matrix, yet only the creator gets [SCR-08]'s editable variant and its Delete account row.
    // Without this field the client cannot tell the two apart.
    const parsed = accountSummarySchema.parse(summary);
    expect(parsed.createdBy).toBe(OID);
    expect(accountSummarySchema.safeParse({ ...summary, createdBy: undefined }).success).toBe(
      false,
    );
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

describe('sendOtpInputSchema / verifyOtpInputSchema', () => {
  it('accepts a 10-digit phone identifier and rejects other shapes', () => {
    expect(
      sendOtpInputSchema.safeParse({ channel: 'phone', identifier: '9999999999' }).success,
    ).toBe(true);
    expect(sendOtpInputSchema.safeParse({ channel: 'phone', identifier: '99999' }).success).toBe(
      false,
    );
    // [SCR-02]'s +91 prefix is a fixed display decoration, never typed — the payload is digits only.
    expect(
      sendOtpInputSchema.safeParse({ channel: 'phone', identifier: '+919999999999' }).success,
    ).toBe(false);
  });

  it('accepts a well-formed email identifier and rejects a malformed one', () => {
    expect(
      sendOtpInputSchema.safeParse({ channel: 'email', identifier: '9999999999@nest.com' }).success,
    ).toBe(true);
    expect(
      sendOtpInputSchema.safeParse({ channel: 'email', identifier: 'not-an-email' }).success,
    ).toBe(false);
  });

  it('ties the identifier shape to its own channel, never the other', () => {
    // A phone-shaped value under 'email' (or vice versa) must fail — [SCR-02] never lets them mix.
    expect(
      sendOtpInputSchema.safeParse({ channel: 'email', identifier: '9999999999' }).success,
    ).toBe(false);
    expect(
      sendOtpInputSchema.safeParse({ channel: 'phone', identifier: '9999999999@nest.com' }).success,
    ).toBe(false);
  });

  it('requires exactly 4 digits for the code, matching [SCR-03]', () => {
    const base = { channel: 'phone' as const, identifier: '9999999999' };
    expect(verifyOtpInputSchema.safeParse({ ...base, code: '9999' }).success).toBe(true);
    expect(verifyOtpInputSchema.safeParse({ ...base, code: '999' }).success).toBe(false);
    expect(verifyOtpInputSchema.safeParse({ ...base, code: '99999' }).success).toBe(false);
    expect(verifyOtpInputSchema.safeParse({ ...base, code: 'abcd' }).success).toBe(false);
  });
});

describe('signUpInputSchema / signInInputSchema', () => {
  const signUp = { channel: 'phone' as const, identifier: '9999999999', name: 'Ananya Sharma' };

  it('enforces the password policy on sign-up', () => {
    expect(signUpInputSchema.safeParse({ ...signUp, password: 'correct-horse' }).success).toBe(
      true,
    );
    expect(signUpInputSchema.safeParse({ ...signUp, password: 'short12' }).success).toBe(false);
    expect(
      signUpInputSchema.safeParse({ ...signUp, password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('trims the name before bounding it, so whitespace cannot pass min(1)', () => {
    // The reason signUpNameSchema is not just profileSchema.shape.name: an all-whitespace name
    // satisfies min(1) untrimmed and would render as a blank in [SCR-04]'s greeting.
    expect(
      signUpInputSchema.safeParse({ ...signUp, name: '   ', password: 'a-good-password' }),
    ).toMatchObject({ success: false });

    const parsed = signUpInputSchema.parse({
      ...signUp,
      name: '  Ananya Sharma  ',
      password: 'a-good-password',
    });
    expect(parsed.name).toBe('Ananya Sharma');
  });

  it('keeps the channel and identifier tied together, as the OTP schemas do', () => {
    const password = 'a-good-password';
    expect(signUpInputSchema.safeParse({ ...signUp, channel: 'email', password }).success).toBe(
      false,
    );
    expect(
      signInInputSchema.safeParse({ channel: 'phone', identifier: 'ananya@nest.com', password })
        .success,
    ).toBe(false);
  });

  it('does not apply the sign-up password policy at the sign-in gate', () => {
    // Deliberate: a policy applied to login locks out every existing user the day the minimum
    // rises, with a field-validation error rather than a way to reset. Sign-in enforces only the
    // DoS bound.
    const base = { channel: 'phone' as const, identifier: '9999999999' };
    expect(signInInputSchema.safeParse({ ...base, password: 'short12' }).success).toBe(true);
    expect(signInInputSchema.safeParse({ ...base, password: '' }).success).toBe(false);
    expect(
      signInInputSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('does not accept a client-supplied username or id', () => {
    // The server derives the username; nothing about a new user's identity is client-chosen
    // beyond the identifier they are proving and the name they are displayed under.
    const parsed = signUpInputSchema.parse({
      ...signUp,
      password: 'a-good-password',
      username: 'admin',
      id: OID,
    });
    expect(parsed).not.toHaveProperty('username');
    expect(parsed).not.toHaveProperty('id');
  });
});

describe('updateProfileDetailsInputSchema', () => {
  it('accepts name and username alone or together', () => {
    expect(updateProfileDetailsInputSchema.safeParse({}).success).toBe(true);
    expect(updateProfileDetailsInputSchema.safeParse({ name: 'Ananya Sharma' }).success).toBe(true);
    expect(updateProfileDetailsInputSchema.safeParse({ username: 'ananya' }).success).toBe(true);
    expect(
      updateProfileDetailsInputSchema.safeParse({ name: 'Ananya Sharma', username: 'ananya' })
        .success,
    ).toBe(true);
  });

  it('does not accept a client-supplied id, email, phone or avatarUrl', () => {
    // The whole point of narrowing this off updateProfileInputSchema: email/phone are sign-in
    // identifiers that can only change through OTP verification (routes/profile.ts's
    // changeIdentifierRoutes), and avatarUrl has no writer at all yet. A route built against this
    // type cannot compile a write from any of the four, regardless of what the handler does.
    const parsed = updateProfileDetailsInputSchema.parse({
      id: OID,
      name: 'Ananya Sharma',
      email: 'attacker@evil.example',
      phone: '9000000000',
      avatarUrl: 'https://evil.example/x.png',
    });
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed).not.toHaveProperty('avatarUrl');
    expect(parsed).toEqual({ name: 'Ananya Sharma' });
  });
});
