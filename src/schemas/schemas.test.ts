import { describe, expect, it } from 'vitest';
import {
  dateOnlyString,
  isoDateString,
  localDateTimeString,
  MAX_ENTRY_AMOUNT,
  moneyAmount,
  moneyTotal,
  objectId,
  signedMoneyAmount,
  MAX_INVITES_PER_ACCOUNT,
  MAX_MEMBER_OPS_PER_SAVE,
  signedMoneyTotal,
  timeOfDayString,
} from './common.js';
import {
  accountManagementSchema,
  accountSchema,
  accountSummarySchema,
  accountManageSaveInputSchema,
  createAccountInputSchema,
  updateAccountInputSchema,
} from './account.js';
import {
  bookSchema,
  bookSettingsSaveInputSchema,
  bookStatsSchema,
  bookSummarySchema,
  createBookInputSchema,
  customFieldTypeSchema,
  duplicateBookInputSchema,
  duplicateBookOptionsSchema,
  MAX_BOOK_LABELS,
  MAX_CUSTOM_FIELDS,
  moveBookInputSchema,
  updateBookInputSchema,
} from './book.js';
import { bootstrapQuerySchema, bootstrapSchema } from './bootstrap.js';
import {
  bulkDeleteEntriesInputSchema,
  bulkLabelEntriesInputSchema,
  bulkTransferEntriesInputSchema,
  createEntryInputSchema,
  entriesQuerySchema,
  entryAuthorsSchema,
  entryCountSchema,
  entrySchema,
  updateEntryInputSchema,
  MAX_BULK_ENTRIES,
} from './entry.js';
import { MAX_QUERY_LIST_VALUES } from './http.js';
import { createDueInputSchema, dueSchema, updateDueInputSchema } from './due.js';
import {
  createReminderInputSchema,
  reminderRepeatSchema,
  reminderSchema,
  reminderStatusSchema,
  updateReminderInputSchema,
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

  // The old "is derivable" test asserted `bookSchema.omit({ id: true })` does not throw, guarding
  // against someone adding an object-level refinement and breaking the input schemas. That guard is
  // now structural: the base is module-private and every derived schema is cut from it at module
  // scope, so a refinement on the base makes this whole file fail to *import*. A louder signal than
  // an assertion, and one that cannot be deleted by accident.

  it('accepts a book whose creator holds no member row, because a Move produces one', () => {
    // The creator-is-a-member refinement was removed in v0.25.0 and this test is the guard against
    // it coming back: decision 14 hands `createdBy` to the destination account's creator, who
    // administers every book in their account through `resolveBookAccess`'s first rung while
    // deliberately holding no row. The narrow rule refuses that book, so re-adding it here would
    // have the contract reject a document the service legitimately writes.
    //
    // The invariant itself is not gone — `book.model.ts` enforces the widened *"a member, or the
    // account's own creator"* at the write boundary, where the account is loaded. `models.test.ts`
    // covers both halves.
    const base = {
      ...validBook,
      id: OID,
      accountId: OID,
      /** Required on a stored book, nullable in meaning: null = inherit the account matrix. */
      perms: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const account = (userId: string) => ({ userId, role: null, kind: 'account' as const });

    expect(bookSchema.safeParse({ ...base, createdBy: OID, members: [account(OID)] }).success).toBe(
      true,
    );
    // The moved book: creator is the destination account's own creator, and no row stands for them.
    expect(
      bookSchema.safeParse({
        ...base,
        createdBy: OID,
        members: [{ userId: OTHER_MEMBER, role: 'EDITOR', kind: 'guest' }],
      }).success,
    ).toBe(true);
    expect(bookSchema.safeParse({ ...base, createdBy: OID, members: [] }).success).toBe(true);
  });

  it('inherits the account role and matrix until something overrides them', () => {
    // `null` means *inherit, live* in both places — the whole of [GAP-2]'s design. A snapshot of the
    // account role would let a demotion on [SCR-08] miss every book the member was already in.
    const base = {
      ...validBook,
      id: OID,
      accountId: OID,
      /** Required on a stored book, nullable in meaning: null = inherit the account matrix. */
      perms: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdBy: OID,
    };

    expect(
      bookSchema.safeParse({
        ...base,
        members: [{ userId: OID, role: null, kind: 'account' }],
        perms: null,
      }).success,
    ).toBe(true);

    // An override on one row, and a detached matrix, are both legal.
    expect(
      bookSchema.safeParse({
        ...base,
        members: [
          { userId: OID, role: null, kind: 'account' },
          { userId: OTHER_MEMBER, role: 'VIEWER', kind: 'account' },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a guest with no role — there is no account role for them to inherit', () => {
    const base = {
      ...validBook,
      id: OID,
      accountId: OID,
      /** Required on a stored book, nullable in meaning: null = inherit the account matrix. */
      perms: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdBy: OID,
    };
    const creator = { userId: OID, role: null, kind: 'account' as const };

    expect(
      bookSchema.safeParse({
        ...base,
        members: [creator, { userId: OTHER_MEMBER, role: null, kind: 'guest' }],
      }).success,
    ).toBe(false);

    expect(
      bookSchema.safeParse({
        ...base,
        members: [creator, { userId: OTHER_MEMBER, role: 'VIEWER', kind: 'guest' }],
      }).success,
    ).toBe(true);
  });

  it('refuses two rows for one person — a set keyed by userId', () => {
    // Otherwise the resolver has to pick between them, which is exactly the ambiguity to design out
    // when a guest later joins the account.
    const base = {
      ...validBook,
      id: OID,
      accountId: OID,
      /** Required on a stored book, nullable in meaning: null = inherit the account matrix. */
      perms: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      createdBy: OID,
    };

    expect(
      bookSchema.safeParse({
        ...base,
        members: [
          { userId: OID, role: null, kind: 'account' },
          { userId: OID, role: 'VIEWER', kind: 'guest' },
        ],
      }).success,
    ).toBe(false);
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
    // '6:42 PM' is [LOG-06]'s timeTok — display only. Asserted on the primitive rather than through
    // the create input, which carries `time` as an optional field now that [OVL-08] has a picker.
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
    const parsed = createEntryInputSchema.parse({ ...validEntry, bookId: OID });
    expect(parsed).not.toHaveProperty('bookId');
  });

  it('refuses an id in upper case, so no comparison can be case-tricked', () => {
    // `ObjectId.toString()` is lower case, so a case-insensitive `objectId` made every
    // `id === other._id.toString()` guard bypassable — one of them let a `bulk-move` name its own
    // book and hard-delete the originals. Rejecting at the boundary is the rule nobody can forget.
    expect(objectId.safeParse('000000000000000000000a01').success).toBe(true);
    expect(objectId.safeParse('000000000000000000000A01').success).toBe(false);
    expect(objectId.safeParse('AABBCCDDEEFF001122334455').success).toBe(false);
  });

  it('carries the concurrency precondition on an entry update, and leaves it optional', () => {
    // A whole-body replacement reverts every field the other editor changed, not just the one they
    // touched — so the client sends back the `updatedAt` it loaded. Optional, so an older client
    // keeps last-write-wins rather than being refused.
    const withPrecondition = updateEntryInputSchema.parse({
      ...validEntry,
      expectedUpdatedAt: '2026-07-31T13:12:00.000Z',
    });
    expect(withPrecondition.expectedUpdatedAt).toBe('2026-07-31T13:12:00.000Z');
    expect(updateEntryInputSchema.parse(validEntry)).not.toHaveProperty('expectedUpdatedAt');
  });

  it('keeps a clearable Due or Reminder note nullable, not merely optional', () => {
    // The `[OVL-08]` bug forestalled: under `.partial()` merge semantics an optional field can never
    // be emptied, because "cleared" and "unmentioned" are the same request. `null` is what makes the
    // difference expressible — the idiom `Due.back` already uses.
    expect(updateDueInputSchema.parse({ notes: null }).notes).toBeNull();
    expect(updateReminderInputSchema.parse({ notes: null }).notes).toBeNull();
    expect(updateDueInputSchema.parse({})).not.toHaveProperty('notes');
  });

  it('carries a client-supplied date and time', () => {
    // The user's device-test decision — `[OVL-08]` has a date and time picker now. Both are
    // wall-clock and zone-less, so the value the picker produces is the value stored.
    const parsed = createEntryInputSchema.parse({
      ...validEntry,
      date: '2026-01-01',
      time: '10:00',
    });
    expect(parsed.date).toBe('2026-01-01');
    expect(parsed.time).toBe('10:00');
  });

  it('leaves date and time optional, so an older client still gets the stamped clock', () => {
    // The frozen behaviour is the default rather than the only option: omit them and the server
    // stamps `APP_TIMEZONE`'s clock, which is what Munim's parser will do ([LOG-11] reads no date).
    const withoutStamp: Record<string, unknown> = { ...validEntry };
    delete withoutStamp.date;
    delete withoutStamp.time;
    const parsed = createEntryInputSchema.parse(withoutStamp);
    expect(parsed).not.toHaveProperty('date');
    expect(parsed).not.toHaveProperty('time');
  });

  it('still refuses a future date only at the service, never here', () => {
    // Deliberately accepted by the schema. "Not in the future" is a comparison against the server's
    // clock in its own zone, which a schema shared with the client cannot make — `entryRules` owns
    // it, and putting a bound here would let a browser's clock decide what the ledger accepts.
    expect(createEntryInputSchema.parse({ ...validEntry, date: '2999-01-01' }).date).toBe(
      '2999-01-01',
    );
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

  it('trims the account name on rename too, not only on create', () => {
    // The same [OVL-17] gate as the test above, one step later. `updateAccountInputSchema` derives
    // by `.pick()`, which carried accountBaseSchema's bare .min(1) through — so before the override
    // the trim guarantee held only until the first rename, which is the whole point of having it.
    expect(updateAccountInputSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(updateAccountInputSchema.safeParse({ name: '\t\n ' }).success).toBe(false);

    expect(updateAccountInputSchema.parse({ name: '  Sharma Family  ' }).name).toBe(
      'Sharma Family',
    );

    // Still a PATCH: every field stays optional, and an empty patch is not an error.
    expect(updateAccountInputSchema.safeParse({}).success).toBe(true);
    expect(updateAccountInputSchema.safeParse({ initial: 'S' }).success).toBe(true);
  });

  it('refuses membership changes through the account update route', () => {
    // [SCR-08] routes role changes and removals through their own endpoints, which carry their own
    // authorization. A `members` key here would be a second, ungated path to the same state.
    const parsed = updateAccountInputSchema.parse({
      name: 'Sharma Family',
      members: [{ userId: OID, name: 'Rohit', contact: 'r@example.com', role: 'ADMIN' }],
    } as never);
    expect(parsed).not.toHaveProperty('members');
  });

  it('requires an invite contact to be a phone number or an email', () => {
    // contactKeyOf strips non-digits when it sees no '@', so free text normalises to a key that can
    // match a real person while `contact` — which [SCR-08] renders verbatim — keeps the whole string.
    const invite = (contact: string) =>
      createInviteInputSchema.safeParse({ contact, role: 'EDITOR' }).success;

    expect(invite('9876543210')).toBe(true);
    expect(invite('+91 98450 22118')).toBe(true);
    expect(invite('someone@example.com')).toBe(true);

    expect(invite('+919845022118')).toBe(true);
    expect(invite('09845022118')).toBe(true);

    expect(invite('7')).toBe(false);
    /**
     * A trailing typo must not pass. `contactKeyOf` keeps the **last** ten digits, so an eleven-digit
     * value silently re-addresses the invite to a different subscriber — `98450221180` resolves to
     * `8450221180`. The recipient has no way to notice: `myInviteSchema` omits `contact`.
     */
    expect(invite('98450221180')).toBe(false);
    expect(invite('9845022118 0')).toBe(false);
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
    /** `[OVL-18]`'s five rows plus `[SCR-07]`'s two membership gates, resolved server-side. */
    myAuthority: {
      edit: true,
      duplicate: true,
      move: true,
      delete: true,
      leave: false,
      grant: true,
      revoke: true,
    },
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

describe('[SCR-08] accountManagementSchema', () => {
  const OTHER = '507f1f77bcf86cd799439012';
  const management = {
    id: OID,
    name: 'Sharma Family',
    kind: 'SHARED' as const,
    initial: 'S',
    createdBy: OID,
    members: [
      { userId: OID, name: 'Ananya Sharma', contact: 'ananya@gmail.com', role: 'ADMIN' as const },
      { userId: OTHER, name: 'Rohit Sharma', contact: '9845022118', role: 'EDITOR' as const },
    ],
    permissions: ROLE_PERMISSION_SEED,
    myCapabilities: ROLE_PERMISSION_SEED.ADMIN,
    invites: [
      {
        id: OID,
        contact: 'meera@example.com',
        name: 'Meera Iyer',
        role: 'VIEWER' as const,
        status: 'pending' as const,
      },
    ],
    facts: { bookCount: 3, entryCount: 41 },
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  };

  it('accepts the Manage-account payload', () => {
    expect(accountManagementSchema.safeParse(management).success).toBe(true);
  });

  it('carries every member contact and the editable matrix — the one screen that may', () => {
    // The inverse of accountSummarySchema's two withholding tests. [SCR-08] is the only screen the
    // frozen design draws a contact on, and the only one that edits the matrix.
    const parsed = accountManagementSchema.parse(management);
    expect(parsed.members[0]).toHaveProperty('contact', 'ananya@gmail.com');
    expect(rolePermissionsSchema.safeParse(parsed.permissions).success).toBe(true);
  });

  it('still resolves the caller’s own capabilities server-side', () => {
    // nest-authz holds even here: the client now *has* the matrix, so the temptation to find itself
    // in members[] and index it is real. myCapabilities is what makes that unnecessary.
    expect(permissionsSchema.safeParse(management.myCapabilities).success).toBe(true);
    const withoutMine: Record<string, unknown> = { ...management };
    delete withoutMine.myCapabilities;
    expect(accountManagementSchema.safeParse(withoutMine).success).toBe(false);
  });

  it('keeps the creator-is-a-member invariant across the wire', () => {
    // A response is still a state. The floor of administrability should not go unchecked just
    // because it was serialised.
    const orphaned = {
      ...management,
      members: [management.members[1]],
    };
    expect(accountManagementSchema.safeParse(orphaned).success).toBe(false);
  });

  it('requires [OVL-17]’s facts, because the sheet must never guess a count', () => {
    // [OVL-17]: "Counts are computed, never guessed." An absent facts object would let the sheet
    // render a blank BOOKS DELETED row next to an irreversible button.
    const withoutFacts: Record<string, unknown> = { ...management };
    delete withoutFacts.facts;
    expect(accountManagementSchema.safeParse(withoutFacts).success).toBe(false);

    expect(
      accountManagementSchema.safeParse({ ...management, facts: { bookCount: -1, entryCount: 0 } })
        .success,
    ).toBe(false);
  });

  it('carries a revoked invite rather than dropping it, so undo is a status flip', () => {
    const revoked = {
      ...management,
      invites: [{ ...management.invites[0], status: 'revoked' as const }],
    };
    expect(accountManagementSchema.safeParse(revoked).success).toBe(true);
  });

  it('caps the invite list at family scale', () => {
    const many = Array.from({ length: MAX_INVITES_PER_ACCOUNT + 1 }, () => management.invites[0]);
    expect(accountManagementSchema.safeParse({ ...management, invites: many }).success).toBe(false);
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

describe('[OVL-04] entriesQuerySchema — the ledger filters', () => {
  it('treats one, many and no values for a repeatable filter alike', () => {
    // The whole reason `queryList` preprocesses: Fastify hands back a bare string for a single
    // occurrence and an array for a repeated one. Without normalisation `?categories=Food` fails
    // while `?categories=Food&categories=Rent` passes — a filter that only works from two chips up.
    expect(entriesQuerySchema.parse({ categories: 'Food' }).categories).toEqual(['Food']);
    expect(entriesQuerySchema.parse({ categories: ['Food', 'Rent'] }).categories).toEqual([
      'Food',
      'Rent',
    ]);
    expect(entriesQuerySchema.parse({}).categories).toEqual([]);
  });

  it('defaults every filter to "no filter", so an unfiltered ledger sends nothing', () => {
    const parsed = entriesQuerySchema.parse({});
    expect(parsed.range).toBe('all');
    expect(parsed.type).toBeUndefined();
    expect(parsed).toMatchObject({ categories: [], paymentModes: [], createdBy: [] });
  });

  it('has no "all" member on type — the ALL chip is a cleared filter, not a third direction', () => {
    // Two wire values meaning the same thing is how `fCount` starts disagreeing with the chips.
    expect(entriesQuerySchema.safeParse({ type: 'all' }).success).toBe(false);
    expect(entriesQuerySchema.parse({ type: 'in' }).type).toBe('in');
  });

  it('bounds each list, so one request cannot turn an index seek into a scan', () => {
    const tooMany = Array.from({ length: MAX_QUERY_LIST_VALUES + 1 }, (_, i) => `c${String(i)}`);
    expect(entriesQuerySchema.safeParse({ categories: tooMany }).success).toBe(false);
  });

  it('requires ADDED BY to be ids, never names', () => {
    // [LOG-01] writes `who` as a member name only because the prototype has no user records.
    expect(entriesQuerySchema.safeParse({ createdBy: 'Ananya' }).success).toBe(false);
    expect(entriesQuerySchema.parse({ createdBy: OID }).createdBy).toEqual([OID]);
  });

  it('keeps the pagination contract it extends', () => {
    expect(entriesQuerySchema.parse({}).limit).toBe(50);
    expect(entriesQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });
});

describe('[OVL-04] the two facet responses', () => {
  it('keeps the draft count and the book-wide author list on separate responses', () => {
    // Two lifetimes: the count changes with every chip tap, the author list never does. One
    // response made the client re-fetch an unfiltered whole-book scan per keystroke.
    expect(entryCountSchema.parse({ matches: 12 })).toEqual({ matches: 12 });
    expect(entryAuthorsSchema.parse({ authors: [OID] })).toEqual({ authors: [OID] });
  });

  it('rejects a negative or fractional match count', () => {
    expect(entryCountSchema.safeParse({ matches: -1 }).success).toBe(false);
    expect(entryCountSchema.safeParse({ matches: 1.5 }).success).toBe(false);
  });
});

describe('length bounds that keep one tenant from taxing the shared process', () => {
  const many = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

  it('caps a book’s categories and payment modes', () => {
    // Unbounded, one PATCH stores tens of thousands of labels inside the 1 MB body limit, and every
    // later read of that book re-serialises all of them on the process every family shares.
    expect(
      updateBookInputSchema.safeParse({ categories: many(MAX_BOOK_LABELS, 'c') }).success,
    ).toBe(true);
    expect(
      updateBookInputSchema.safeParse({ categories: many(MAX_BOOK_LABELS + 1, 'c') }).success,
    ).toBe(false);
    expect(
      updateBookInputSchema.safeParse({ paymentModes: many(MAX_BOOK_LABELS + 1, 'm') }).success,
    ).toBe(false);
  });

  it('caps custom fields on the create path too, not only the update path', () => {
    // The bound lives on the base schema precisely so both inputs inherit it — capping only the
    // update would leave the identical hole open one route over.
    const fields = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `507f1f77bcf86cd7994${String(i).padStart(5, '0')}`,
        name: `f${String(i)}`,
        type: 'text' as const,
      }));

    expect(
      updateBookInputSchema.safeParse({ customFields: fields(MAX_CUSTOM_FIELDS) }).success,
    ).toBe(true);
    expect(
      updateBookInputSchema.safeParse({ customFields: fields(MAX_CUSTOM_FIELDS + 1) }).success,
    ).toBe(false);
    expect(
      createBookInputSchema.safeParse({
        name: 'Household',
        tint: '#B4472C',
        opening: 0,
        categories: ['Groceries'],
        paymentModes: ['UPI'],
        customFields: fields(MAX_CUSTOM_FIELDS + 1),
        useCategory: true,
        useMode: true,
        useAttach: false,
      }).success,
    ).toBe(false);
  });

  it('caps how many customValues one entry may carry', () => {
    // The hole the value-length bound left open: 20,000 booleans carry no long strings and still
    // make one limit=100 page a ~64 MB response whose every key runs the objectId regex.
    const values = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `507f1f77bcf86cd7994${String(i).padStart(5, '0')}`,
          true,
        ]),
      );

    expect(
      createEntryInputSchema.safeParse({
        type: 'out',
        amount: 100,
        customValues: values(MAX_CUSTOM_FIELDS),
      }).success,
    ).toBe(true);
    expect(
      createEntryInputSchema.safeParse({
        type: 'out',
        amount: 100,
        customValues: values(MAX_CUSTOM_FIELDS + 1),
      }).success,
    ).toBe(false);
  });
});

describe('[SCR-07] updateBookInputSchema — custom fields', () => {
  const OTHER = '507f1f77bcf86cd799439014';
  const field = { id: OID, name: 'Vendor', type: 'text' as const };

  it('requires an id on every field, exactly as createBookInputSchema does', () => {
    // One authority model for one nested type: both routes take the id from the client. Making it
    // optional here would mean whoever builds [SCR-07]'s field editor has to know which route they
    // are on, with nothing in the types to tell them.
    expect(updateBookInputSchema.parse({ customFields: [field] }).customFields).toEqual([field]);
    expect(
      updateBookInputSchema.safeParse({ customFields: [{ name: 'Vendor', type: 'text' }] }).success,
    ).toBe(false);
  });

  it('accepts several fields with distinct ids', () => {
    expect(
      updateBookInputSchema.safeParse({
        customFields: [field, { id: OTHER, name: 'Warranty till', type: 'text' }],
      }).success,
    ).toBe(true);
  });

  it('rejects two fields sharing one id', () => {
    // Entry.customValues keys off these, so a duplicate id makes one entry's value ambiguous.
    expect(
      updateBookInputSchema.safeParse({
        customFields: [field, { id: OID, name: 'Reference', type: 'text' }],
      }).success,
    ).toBe(false);
  });

  it('still refuses everything [SCR-07] does not edit', () => {
    // `opening` is the sharp one: it moves every figure [LOG-05] derives, with no entry to point
    // at and no undo. See the allowlist's own comment.
    const parsed = updateBookInputSchema.parse({
      name: 'Household',
      opening: 999,
      accountId: OID,
      createdBy: OID,
      members: [OID],
      tint: '#b4472c',
      sub: 'anything',
    });
    expect(parsed).toEqual({ name: 'Household' });
  });
});

describe('bookSummarySchema — a withheld book is null, never zero [GAP-2]', () => {
  const base = {
    id: OID,
    accountId: OID,
    /** `[SCR-06]`'s eyebrow — the one thing a guest cannot resolve from `accountId` themselves. */
    accountName: 'Sharma Family',
    name: 'Renovation',
    tint: '#B4472C',
    createdBy: OID,
    opening: 0,
    categories: [],
    paymentModes: [],
    customFields: [],
    useCategory: true,
    useMode: true,
    useAttach: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    month: '2026-07',
    /** `[OVL-18]`'s header meta. Membership, not an entry-derived figure — never withheld. */
    memberCount: 4,
    myCapabilities: {
      viewEntries: false,
      addEntries: true,
      editAnyEntry: false,
      deleteEntries: false,
      manageMembers: false,
      bookSettings: false,
    },
    /** `[OVL-18]`'s five rows plus `[SCR-07]`'s two membership gates, resolved server-side. */
    myAuthority: {
      edit: true,
      duplicate: true,
      move: true,
      delete: true,
      leave: false,
      grant: true,
      revoke: true,
    },
  };

  it('accepts null figures for a caller whose per-book viewEntries is false', () => {
    // The "log your spending, do not read the ledger" configuration the matrix exists to express.
    expect(
      bookSummarySchema.safeParse({ ...base, stats: null, entryCount: null, monthNet: null })
        .success,
    ).toBe(true);
  });

  it('still accepts real figures for a caller who may read the book', () => {
    expect(
      bookSummarySchema.safeParse({
        ...base,
        myCapabilities: { ...base.myCapabilities, viewEntries: true },
        stats: { cin: 100, cout: 40, bal: 60 },
        entryCount: 2,
        monthNet: 60,
      }).success,
    ).toBe(true);
  });

  it('does not let the fields be omitted — withheld is a value, not an absence', () => {
    // An omitted key would let a mapper forget to answer and have it read as "withheld", which is
    // the failure mode `toBookSummary`'s required parameter is guarding against on the other side.
    expect(bookSummarySchema.safeParse({ ...base, entryCount: null, monthNet: null }).success).toBe(
      false,
    );
  });

  it('keeps memberCount when every entry-derived figure is withheld', () => {
    // The line between the two kinds of withholding, pinned: `stats`, `entryCount` and `monthNet`
    // are entry-derived and null out together for a caller without `viewEntries`. `memberCount` is
    // membership, so `[OVL-18]`'s header still says `4 MEMBERS` for someone who may not read the
    // ledger — and the sheet has an answer instead of an empty meta line.
    const withheld = bookSummarySchema.safeParse({
      ...base,
      stats: null,
      entryCount: null,
      monthNet: null,
    });
    expect(withheld.success && withheld.data.memberCount).toBe(4);
  });

  it('refuses a null memberCount — it is a count, not a withholdable figure', () => {
    expect(
      bookSummarySchema.safeParse({
        ...base,
        stats: null,
        entryCount: null,
        monthNet: null,
        memberCount: null,
      }).success,
    ).toBe(false);
  });

  it('accepts memberCount 0 so one un-migrated book cannot fault the whole list', () => {
    // `bookMemberCount` cannot return zero — the account's creator is counted whether or not they
    // hold a row. It is accepted anyway because a response contract must never be what takes
    // `[SCR-05]` down — the same reasoning as `resolveBookAccess`'s `Array.isArray` guard.
    expect(
      bookSummarySchema.safeParse({
        ...base,
        stats: null,
        entryCount: null,
        monthNet: null,
        memberCount: 0,
      }).success,
    ).toBe(true);
  });
});

describe('duplicateBookInputSchema — [OVL-19]', () => {
  const copy = {
    members: true,
    categories: true,
    paymentModes: true,
    customFields: false,
    opening: false,
    reminders: false,
  };

  it('accepts a name and all six flags', () => {
    const parsed = duplicateBookInputSchema.safeParse({
      name: 'Renovation copy',
      tint: '#B4472C',
      copy,
    });
    expect(parsed.success && parsed.data.copy.members).toBe(true);
  });

  it('refuses a partial copy object — no flag defaults either way', () => {
    // `members` carries the book's `perms` matrix with it ([LOG-18], decision 5), so a defaulted
    // flag would be a silent decision about who can read a family's money.
    const withoutMembers = {
      categories: true,
      paymentModes: true,
      customFields: false,
      opening: false,
      reminders: false,
    };
    expect(
      duplicateBookInputSchema.safeParse({ name: 'X', tint: '#B4472C', copy: withoutMembers })
        .success,
    ).toBe(false);
  });

  it('holds the copy to the same name bounds as the original', () => {
    // Cut from `bookBaseSchema`, so a copy can never take a name the source could not hold.
    expect(duplicateBookInputSchema.safeParse({ name: '', tint: '#B4472C', copy }).success).toBe(
      false,
    );
    expect(
      duplicateBookInputSchema.safeParse({ name: 'x'.repeat(61), tint: '#B4472C', copy }).success,
    ).toBe(false);
  });

  it('requires a tint, held to the same format the original is', () => {
    // [LOG-18] gives the copy `TINTS[books.length % 6]` — a *new* tint, so a copy sitting next to
    // its original on [SCR-05] is not two rows with an identical rail. The client owns the palette
    // and applies the rule, exactly as it does on create.
    expect(duplicateBookInputSchema.safeParse({ name: 'Renovation copy', copy }).success).toBe(
      false,
    );
    expect(
      duplicateBookInputSchema.safeParse({ name: 'Renovation copy', tint: 'orange', copy }).success,
    ).toBe(false);
  });

  it('carries no entries flag — a duplicate of a ledger carries the ledger', () => {
    // [OVL-19]: "Entries are not a checkbox... Do not add a toggle for it." Pinned so nobody adds
    // one by reading the six-checkbox list as the whole story.
    expect(Object.keys(duplicateBookOptionsSchema.shape)).not.toContain('entries');
  });

  it('names no destination account — the copy lands beside the original', () => {
    // Same reason `createBookInputSchema` omits `accountId`: the server resolved it from the source
    // book it just authorized, and a body copy would be a second claim about where the write goes.
    const parsed = duplicateBookInputSchema.safeParse({
      name: 'Renovation copy',
      tint: '#B4472C',
      copy,
      accountId: OID,
    });
    expect(parsed.success && 'accountId' in parsed.data).toBe(false);
  });
});

describe('moveBookInputSchema — [OVL-20]', () => {
  it('accepts a destination account id', () => {
    expect(moveBookInputSchema.safeParse({ accountId: OID }).success).toBe(true);
  });

  it('refuses anything that is not an object id', () => {
    expect(moveBookInputSchema.safeParse({ accountId: 'my-money' }).success).toBe(false);
    expect(moveBookInputSchema.safeParse({}).success).toBe(false);
  });

  it('names no source — the source is the authorized :bookId, never a body claim', () => {
    const parsed = moveBookInputSchema.safeParse({ accountId: OID, bookId: OID });
    expect(parsed.success && 'bookId' in parsed.data).toBe(false);
  });
});

/**
 * `[LOG-21]`'s bulk operations. What is worth pinning here is not that ids parse — it is the three
 * places the contract deliberately refuses to let the client answer a question the server must.
 */
describe('[LOG-21] bulk entry operations', () => {
  const SECOND_OID = '507f1f77bcf86cd799439012';
  const ids = [OID, SECOND_OID];

  it('bounds the selection, and refuses an empty one', () => {
    expect(bulkDeleteEntriesInputSchema.safeParse({ entryIds: ids }).success).toBe(true);
    // [LOG-21] makes an empty selection unrepresentable — toggleSel returns to null on the last
    // uncheck — so zero ids is a client bug, not a no-op to absorb.
    expect(bulkDeleteEntriesInputSchema.safeParse({ entryIds: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_BULK_ENTRIES + 1 }, () => OID);
    expect(bulkDeleteEntriesInputSchema.safeParse({ entryIds: tooMany }).success).toBe(false);
  });

  it('names no source book — the source is the authorized :bookId', () => {
    const parsed = bulkTransferEntriesInputSchema.safeParse({
      entryIds: ids,
      destinationBookId: OID,
      bookId: SECOND_OID,
    });
    expect(parsed.success && 'bookId' in parsed.data).toBe(false);
  });

  it('carries no mode — copy and move are two routes, because they need two gates', () => {
    const parsed = bulkTransferEntriesInputSchema.safeParse({
      entryIds: ids,
      destinationBookId: OID,
      mode: 'move',
    });
    expect(parsed.success && 'mode' in parsed.data).toBe(false);
  });

  it('carries no createLabel flag — whether a label is new selects a capability', () => {
    const parsed = bulkLabelEntriesInputSchema.safeParse({
      entryIds: ids,
      field: 'paymentMode',
      value: 'RuPay',
      createLabel: true,
    });
    expect(parsed.success && 'createLabel' in parsed.data).toBe(false);
  });

  it('trims the label and refuses a blank or over-long one', () => {
    const parsed = bulkLabelEntriesInputSchema.safeParse({
      entryIds: ids,
      field: 'category',
      value: '  Groceries  ',
    });
    expect(parsed.success && parsed.data.value).toBe('Groceries');
    expect(
      bulkLabelEntriesInputSchema.safeParse({ entryIds: ids, field: 'category', value: '   ' })
        .success,
    ).toBe(false);
    expect(
      bulkLabelEntriesInputSchema.safeParse({
        entryIds: ids,
        field: 'category',
        value: 'x'.repeat(41),
      }).success,
    ).toBe(false);
  });

  it('refuses a field outside [OVL-26]s two lists', () => {
    expect(
      bulkLabelEntriesInputSchema.safeParse({ entryIds: ids, field: 'remark', value: 'x' }).success,
    ).toBe(false);
  });
});

/* [SCR-07] / [SCR-08] deferred save — DECISIONS.md, 2026-08-19. The refusals below are the contract:
   every one of them is an ambiguity the server would otherwise have to resolve by array order. */

describe('bookSettingsSaveInputSchema', () => {
  const a = 'a'.repeat(24);
  const b = 'b'.repeat(24);

  it('defaults both change groups, so a bare rename is still a valid save', () => {
    const parsed = bookSettingsSaveInputSchema.safeParse({ name: 'Groceries' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.members).toEqual({ add: [], setRole: [], remove: [] });
    expect(parsed.success && parsed.data.invites).toEqual({ send: [], revoke: [] });
  });

  it('keeps perms tri-state — absent is not the same command as null', () => {
    const untouched = bookSettingsSaveInputSchema.safeParse({ name: 'Groceries' });
    // Absent must stay absent. Were it defaulted to null the server could not tell "do not touch the
    // matrix" from "re-attach this book to its account's", and every rename would re-attach.
    expect(untouched.success && 'perms' in untouched.data).toBe(false);
    expect(bookSettingsSaveInputSchema.safeParse({ perms: null }).success).toBe(true);
  });

  it('refuses the same member in two intents, whichever pair', () => {
    expect(
      bookSettingsSaveInputSchema.safeParse({
        members: { setRole: [{ userId: a, role: 'EDITOR' }], remove: [a] },
      }).success,
    ).toBe(false);
    expect(
      bookSettingsSaveInputSchema.safeParse({
        members: { add: [{ userId: a, role: null }], remove: [a] },
      }).success,
    ).toBe(false);
    // Two different people in two different intents is the ordinary case and must still pass.
    expect(
      bookSettingsSaveInputSchema.safeParse({
        members: { setRole: [{ userId: a, role: 'EDITOR' }], remove: [b] },
      }).success,
    ).toBe(true);
  });

  it('refuses a duplicate inside one list', () => {
    expect(
      bookSettingsSaveInputSchema.safeParse({
        members: {
          setRole: [
            { userId: a, role: 'EDITOR' },
            { userId: a, role: 'VIEWER' },
          ],
        },
      }).success,
    ).toBe(false);
    expect(bookSettingsSaveInputSchema.safeParse({ invites: { revoke: [a, a] } }).success).toBe(
      false,
    );
  });

  it('caps each list', () => {
    const many = Array.from(
      { length: MAX_MEMBER_OPS_PER_SAVE + 1 },
      (_, i) => (i % 2 === 0 ? 'a' : 'b') + String(i).padStart(23, '0'),
    );
    expect(bookSettingsSaveInputSchema.safeParse({ members: { remove: many } }).success).toBe(
      false,
    );
  });

  it('still accepts role: null, which reverts to the inherited account role rather than removing', () => {
    const parsed = bookSettingsSaveInputSchema.safeParse({
      members: { setRole: [{ userId: a, role: null }] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('accountManageSaveInputSchema', () => {
  const a = 'a'.repeat(24);
  const b = 'b'.repeat(24);

  it('has no way to add a member — [LOG-15] puts consent on the invitation', () => {
    const parsed = accountManageSaveInputSchema.safeParse({
      members: { add: [{ userId: a, role: 'EDITOR' }] },
    });
    // The key is stripped rather than rejected (zod objects are non-strict here, matching every
    // other input schema), so the assertion is that it cannot reach the handler.
    expect(parsed.success && 'add' in parsed.data.members).toBe(false);
  });

  it('refuses the same member, or the same invitation, in two intents', () => {
    expect(
      accountManageSaveInputSchema.safeParse({
        members: { setRole: [{ userId: a, role: 'ADMIN' }], remove: [a] },
      }).success,
    ).toBe(false);
    expect(
      accountManageSaveInputSchema.safeParse({
        invites: { setRole: [{ inviteId: a, role: 'ADMIN' }], revoke: [a] },
      }).success,
    ).toBe(false);
    expect(
      accountManageSaveInputSchema.safeParse({
        members: { setRole: [{ userId: a, role: 'ADMIN' }], remove: [b] },
      }).success,
    ).toBe(true);
  });

  it('carries the name and matrix from the same bar, so one save commits both', () => {
    const parsed = accountManageSaveInputSchema.safeParse({
      name: 'Sharma Family',
      members: { remove: [a] },
    });
    expect(parsed.success && parsed.data.name).toBe('Sharma Family');
    expect(parsed.success && parsed.data.members.remove).toEqual([a]);
  });
});

/* Found by contract-guardian before v0.27.0 shipped: the batch schema inherited `initial` from
   `updateAccountInputSchema`, which the live route hand-excludes because the server owns it. */
describe('accountManageSaveInputSchema — the server owns the initial', () => {
  it('cannot set the account initial, independently or at all', () => {
    const parsed = accountManageSaveInputSchema.safeParse({ name: 'Sharma Family', initial: 'Z' });
    expect(parsed.success).toBe(true);
    // Stripped, not rejected — so a stale client cannot produce a chip that disagrees with the name.
    expect(parsed.success && 'initial' in parsed.data).toBe(false);
  });
});

describe('bootstrapSchema', () => {
  /**
   * `[SCR-00]`'s boot payload. The composition itself needs no assertion — every field *is* the
   * schema the dedicated route returns, and `nest-data-service/src/routes/bootstrap.test.ts` parses
   * real responses through this schema via Fastify's serializer, including two cases that assert the
   * payload equals what `GET /accounts` and `GET /accounts/:accountId/books` return field for field.
   * Restating a thirty-field `bookSummary` fixture here would re-test zod's object composition.
   *
   * What is worth pinning here is the part that is a **decision** rather than a composition: the two
   * nullable fields, and the fact that `books` has three distinguishable states. That is the bit a
   * future edit could quietly collapse.
   */
  it('distinguishes all three states of `books`', () => {
    const books = bootstrapSchema.shape.books;

    // `null` — "not answered here, ask the route". The caller is in no account, or holds no
    // `viewEntries` on the chosen one.
    expect(books.safeParse(null).success).toBe(true);
    // `[]` — a settled "this account has no books", which `[LOG-07]` renders as NO BOOKS YET with a
    // create CTA. Collapsing this into `null` would lose the empty state; collapsing `null` into
    // this would show a confident, wrong empty state to someone who was refused the list.
    expect(books.safeParse([]).success).toBe(true);
    // Anything else is still a real book list.
    expect(books.safeParse(undefined).success).toBe(false);
  });

  it('allows a caller who is in no account at all', () => {
    // Not an error state: `provisionPersonalAccount` covers sign-up, but every account a user is in
    // can subsequently be left or deleted, and `[SCR-04]` has an empty branch for it.
    expect(bootstrapSchema.shape.accountId.safeParse(null).success).toBe(true);
    expect(bootstrapSchema.shape.accounts.safeParse([]).success).toBe(true);
  });

  it('rejects an accountId that is not an ObjectId', () => {
    expect(bootstrapSchema.shape.accountId.safeParse('not-an-id').success).toBe(false);
  });
});

describe('bootstrapQuerySchema', () => {
  it('requires a month', () => {
    // `bootstrapSchema` makes `bookSummary.month` non-optional, so without one the contracted
    // response is unsatisfiable — the same reason `booksQuerySchema` requires it.
    expect(bootstrapQuerySchema.safeParse({}).success).toBe(false);
    expect(bootstrapQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(bootstrapQuerySchema.safeParse({ month: '2026-07' }).success).toBe(true);
  });

  it('treats the account hint as optional', () => {
    // A first-ever load has nothing remembered, so its absence is the ordinary case rather than a
    // malformed request.
    expect(bootstrapQuerySchema.safeParse({ month: '2026-07' }).success).toBe(true);
    expect(bootstrapQuerySchema.safeParse({ month: '2026-07', account: OID }).success).toBe(true);
  });

  it('accepts a malformed hint rather than refusing the boot', () => {
    /**
     * The hint is read from `localStorage`, so anything on the device can write it — and rejecting a
     * malformed one at the boundary would answer `400` on every boot attempt, which `[SCR-00b]`'s
     * *Try again* would resend unchanged. Accepting it is safe because the handler only ever compares
     * it with `===` against ids from the caller's own membership list; it never reaches Mongo.
     */
    expect(bootstrapQuerySchema.safeParse({ month: '2026-07', account: 'x' }).success).toBe(true);
    // The length cap is the one bound worth keeping.
    expect(
      bootstrapQuerySchema.safeParse({ month: '2026-07', account: 'x'.repeat(65) }).success,
    ).toBe(false);
  });
});
