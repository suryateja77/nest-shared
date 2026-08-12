import { z } from 'zod';
import {
  monthString,
  moneyTotal,
  objectId,
  signedMoneyAmount,
  signedMoneyTotal,
  timestampsSchema,
} from './common.js';
import { permissionsSchema, rolePermissionsSchema, roleSchema } from './role.js';

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
 * How many categories or payment modes one book may carry.
 *
 * **A length bound is a security control here, not tidiness.** These arrays are written by any
 * member who can edit a book — and `provisionPersonalAccount` makes every new signup the ADMIN of
 * their own account, so that is any signed-in user. Unbounded, one `PATCH` could store tens of
 * thousands of labels within the 1 MB body limit, and every subsequent read of that book would
 * re-serialise and re-validate all of them on the single process every family shares.
 *
 * Fifty is far above anything the design can draw: `[SCR-07]` renders these as a hand-built,
 * numbered, individually reorderable list, and the largest preset ships nine.
 */
export const MAX_BOOK_LABELS = 50;

/**
 * How many custom fields one book may define. Lower than the label cap because each one is also a
 * *key* on every entry — see `entrySchema.customValues`, which is bounded against this same number.
 * `[SCR-07]`'s `+ ADD` offers four suggested names before falling back to `Note n`.
 */
export const MAX_CUSTOM_FIELDS = 20;

/**
 * Categories and payment modes are grouping keys, not just labels: [LOG-05] aggregates cash-out
 * `byCat` and `byMode` for Insights. A duplicate would silently split one total into two rows, and
 * [SCR-07] lets these be renamed and reordered freely, so uniqueness is enforced here rather than
 * left to the editor.
 */
const uniqueLabels = z
  .array(z.string().min(1).max(40))
  .max(MAX_BOOK_LABELS)
  .refine(isUnique, 'Entries must be unique');

/**
 * How a person reaches a book — `[GAP-2]`, built.
 *
 * `account` is a member of the book's account who was added to this book. `guest` is someone from
 * **outside** the account, invited to this book alone. They are one array rather than two because
 * `[SCR-07]` renders one member list, and because an authorization resolver that reads one list
 * cannot silently miss half the members.
 */
export const bookMemberKindSchema = z.enum(['account', 'guest']);
export type BookMemberKind = z.infer<typeof bookMemberKindSchema>;

/**
 * One row of a book's membership.
 *
 * **`role: null` means *inherit the account role*, resolved live on every request — never a
 * snapshot.** That distinction is the whole design and it is a security property, not a preference:
 * `[LOG-16]`'s own save-bar hint reads `PERMISSIONS APPLY TO EVERY BOOK IN THIS ACCOUNT`, so if this
 * field copied the account role at add-time, demoting someone from EDITOR to VIEWER on `[SCR-08]`
 * would leave them EDITOR in every book they were already in — invisibly, and forever. Storing the
 * absence of an override and resolving it at read time makes the account matrix keep reaching every
 * book that never overrode it.
 *
 * A **guest has no account role to inherit**, so the refinement below requires an explicit one. This
 * is why `role` cannot simply be non-nullable with a sentinel: the two states are genuinely
 * different, and only one of them is legal for a guest.
 *
 * What a role *can do* here comes from `Book.perms ?? Account.permissions` — see `bookBaseSchema`.
 */
export const bookMemberSchema = z
  .object({
    userId: objectId,
    role: roleSchema.nullable(),
    kind: bookMemberKindSchema,
  })
  .refine((member) => member.kind === 'account' || member.role !== null, {
    message: 'A guest carries an explicit role — there is no account role for them to inherit',
    path: ['role'],
  });
export type BookMember = z.infer<typeof bookMemberSchema>;

/**
 * Module-private, exactly as `accountBaseSchema` is, and for a stronger reason than symmetry.
 *
 * `z.infer` of a refined schema is identical to the base object's inferred type, so an exported
 * `bookBaseSchema.parse(x)` would hand back a value typed `Book` that had skipped
 * `creatorIsAMember`. `nest-shared` is the contract; publishing an invariant-free alias of its
 * central entity is the one thing it must not do. It exists only so the input and response schemas
 * below can be cut from it — zod refuses `.pick()`/`.omit()` on an object carrying a refinement.
 */
const bookBaseSchema = z
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
     * Who can reach this book, and as what — [LOG-01]'s `members: string[]`, widened.
     *
     * **This is now visibility *and* permission.** It used to be ids alone, with capabilities coming
     * from the account matrix keyed by the member's account role, and a per-book override was
     * [GAP-2]. [GAP-2] is built: each row may carry a role that applies in this book only, and a row
     * may belong to someone outside the account entirely.
     *
     * Ordering is not meaningful and no screen renders it, so this is a set keyed by `userId`.
     *
     * [LOG-17] writes `inBook` with a `!b.members` branch for books that predate the field. That
     * branch is deliberately **not** reproduced: `members` is required here and `migrate.ts`
     * backfills every existing book with its account's full membership, which is the same outcome
     * without a permanent "unset means everyone" escape hatch sitting in an access check.
     */
    members: z
      .array(bookMemberSchema)
      .refine((rows) => isUnique(rows.map((row) => row.userId)), 'Members must be unique'),
    /**
     * This book's own capability matrix — **`null` means inherit the account's, live.**
     *
     * Same inheritance contract as `bookMemberSchema.role` one level up, and for the same reason: an
     * account creator editing `[SCR-08]`'s matrix must keep reaching every book that never set its
     * own. A book detaches only when someone actually edits it here, so every book that predates
     * this field migrates to `null` and behaves exactly as it did before.
     *
     * Two levels, both legible: *who holds which role here* is `members[].role`, *what a role may do
     * here* is this. Per-person capability sets were rejected — they multiply to members × books × 6
     * flags with no vocabulary to explain any of it, and the design's whole permission language is
     * role → matrix.
     */
    perms: rolePermissionsSchema.nullable(),
    categories: uniqueLabels,
    paymentModes: uniqueLabels,
    /**
     * Ids must be unique — an entry's `customValues` keys off them.
     *
     * Bounded here on `bookBaseSchema` rather than on the input schemas, so **both**
     * `createBookInputSchema` and `updateBookInputSchema` inherit it. Capping only the update path
     * would leave the same hole open one route over.
     */
    customFields: z
      .array(customFieldSchema)
      .max(MAX_CUSTOM_FIELDS)
      .refine((fields) => isUnique(fields.map((field) => field.id)), 'Field ids must be unique'),
    /**
     * Entry-field toggles from [SCR-07]. [OVL-08] states the rule for these two directly —
     * *"category and mode sections appear only if the book enables those fields"* — so an entry may
     * carry no category or payment mode by design.
     */
    useCategory: z.boolean(),
    useMode: z.boolean(),
    /**
     * **What this toggle *does* is not settled, and nothing here should be read as deciding it.**
     *
     * [LOG-01] names it `useAttach` and groups it on one line with the two above, which reads as a
     * third visibility toggle. But [SCR-07] labels the switch "**Require** attachment", the
     * prototype calls the field `requireAttach` and hints `ON ENTRIES ABOVE ₹10,000`, and
     * [OVL-08]'s rules sentence pointedly covers category and mode only. Those describe a
     * conditional *validation* rule, not a show/hide gate — a different control and a different
     * server check.
     *
     * Moot today: [GAP-4] refuses every attachment outright (`entries/entryRules.ts`), so the flag
     * has no live effect either way, and [SCR-07] stores it without acting on it. The decision
     * belongs with whoever builds [GAP-4]; the field name follows [LOG-01] because that is the
     * naming authority, and the name is not the answer.
     */
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
const creatorIsAMember = (book: {
  createdBy: string;
  members: readonly { userId: string }[];
}): boolean => book.members.some((member) => member.userId === book.createdBy);
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
    /**
     * **`perms` is server-owned at creation and always `null`** — a new book inherits its account's
     * matrix. Accepting one here would let a book be born already detached from `[SCR-08]`, which is
     * the opposite of the inheritance contract, and `[OVL-09]` draws no matrix. Detaching is an
     * explicit later act through the book's own settings.
     */
    perms: true,
  })
  .extend({
    /**
     * `[OVL-09]` step 2's picker — **account members only**, so `kind` is implied rather than sent.
     * A guest cannot be added here: they arrive through an invitation they have to accept, and a
     * create body that could mint guests would be a way to name someone outside the account without
     * their consent.
     *
     * `role` is per-person and optional. Omitted (or `null`) means *inherit the account role*, which
     * is what the picker shows by default; a value is the book creator's deliberate override.
     *
     * Defaulted to `[]`, because `[OVL-09]` renders no picker at all in a single-member account
     * (`nbShared = acct.members.length > 1`). An omitted list means "just me", which is what the
     * server's force-include of the creator produces.
     */
    members: z
      .array(
        z.object({
          userId: objectId,
          role: roleSchema.nullable().default(null),
        }),
      )
      .refine((rows) => isUnique(rows.map((row) => row.userId)), 'Members must be unique')
      .default([]),
  });
export type CreateBookInput = z.infer<typeof createBookInputSchema>;

/**
 * **An allowlist of exactly what `[SCR-07]` Book settings edits**, not the create input minus a few
 * fields — the same shape, and the same reasoning, as `updateAccountInputSchema`.
 *
 * `[SCR-07]` offers the name, the three entry-field switches, the custom fields, and the category
 * and payment-mode lists. Nothing else. Everything absent here is absent because no screen changes
 * it, and a contract that can express a change no screen offers is a route waiting to be written
 * against it:
 *
 * - **`opening`** is the sharp one. It is the only field on a book that moves every figure
 *   `[LOG-05]` derives, so a general update rewriting it would silently restate every historical
 *   balance on `[SCR-06]` — with no entry to point at and no undo, which `[LOG-03]` requires on
 *   anything destructive. It looks like an ordinary field and behaves like a destructive one.
 * - **`accountId`** — moving a book between accounts (`[REQ-4]`) needs `bookSettings` on **both**
 *   the source and the destination, so it needs its own authorized operation.
 * - **`createdBy`** is the authenticated creator, and `[LOG-17]` hangs Move, Archive and Delete off
 *   it.
 * - **`members`** and **`perms`** are the sharpest of all now that `[GAP-2]` is built: between them
 *   they decide who can read a family's money. They are authorized on `Book.createdBy` alone, which
 *   is a *different and narrower* gate than the `canEditBook` that admits everything else in this
 *   schema (`[LOG-17]`: account creator ∨ book creator ∨ the `bookSettings` capability). Folding
 *   them in here would silently hand book membership to every `bookSettings` holder — so they get
 *   their own routes, with their own resolver. See `bookMemberInputSchema` below.
 * - **`tint`** and **`sub`** are acquired at creation from the book count and the chosen preset;
 *   `[OVL-09]` offers no control for either and `[SCR-07]` does not edit them.
 *
 * Widening this is a deliberate act when a screen asks for it, which is the point.
 */
export const updateBookInputSchema = bookBaseSchema
  .pick({
    name: true,
    categories: true,
    paymentModes: true,
    /**
     * A **full replacement** of the array, with `id` still required on every entry — which is what
     * makes the three edits `[SCR-07]` offers expressible: a kept field carries its id, a removed
     * one is simply absent, and a new one arrives with an id the *client* minted.
     *
     * **Client-minted ids are the deliberate convention here, matching `createBookInputSchema`**,
     * where `customFieldSchema.id` is likewise required and `routes/accounts.ts` writes it through.
     * Two authority models for one nested type would be worse than either: whoever builds against
     * this would have to know which route they were on, with nothing in the types to tell them.
     *
     * It is also safe, for the reason the create path gives — an id means nothing outside its own
     * book. `bookBaseSchema` refuses duplicates within one, and `entryRules` resolves an entry's
     * `customValues` keys against that book's own fields, so a collision across books is inert. The
     * caller is already rewriting this array wholesale, so choosing an opaque key inside it grants
     * no authority they did not already have — unlike `accountId`, `createdBy` or `bookId`, which
     * name a resource the server must authorize and are omitted everywhere for that reason.
     */
    customFields: true,
    useCategory: true,
    useMode: true,
    useAttach: true,
  })
  .partial();
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
export const bookSummarySchema = bookBaseSchema.omit({ members: true, perms: true }).extend({
  /**
   * **`null` means withheld, never zero** — the caller's `viewEntries` is false *for this book*.
   *
   * The same argument `accountSummarySchema.stats` already carries, and `[GAP-2]` is what made it
   * reachable here. While `viewEntries` was account-level, anyone who could list a book could read
   * it, so a figure on the row disclosed nothing new. A per-book matrix breaks that: *"Ishaan may
   * log his spending but must not see the renovation ledger"* is exactly the configuration the
   * matrix exists to express, and `GET /accounts/:accountId/books` was still shipping that book's
   * balance, entry count and month delta on the row.
   *
   * Nullable rather than omitted, because `[SCR-05]` has to *draw* the difference — a withheld
   * balance is a real state with its own treatment, and `0` would render as a confident "nothing
   * here" for a book that may hold a great deal.
   */
  stats: bookStatsSchema.nullable(),
  entryCount: z.number().int().nonnegative().nullable(),
  /** `cin − cout` restricted to `month`. Signed, a total rather than an entered amount, and
   *  withheld with the rest when the caller may not read this book's entries. */
  monthNet: signedMoneyTotal.nullable(),
  /** Echoed back so a client cannot misattribute a delta to the wrong month. */
  month: monthString,
  /**
   * The caller's own six capabilities **in this book**, already resolved server-side against
   * `Book.perms ?? Account.permissions` and the role in force for them here.
   *
   * New, and now load-bearing. While permissions were account-level, `AccountSummary.myCapabilities`
   * answered for every book in the account and the client could gate on it once. With `[GAP-2]`
   * built, two books in one account can grant the same person different capabilities, so the answer
   * has to travel with the book.
   *
   * Resolved server-side for the same reason `accountSummarySchema` withholds the account matrix:
   * shipping `perms` and letting the client find its own row, read its effective role and index the
   * matrix is the client re-deriving capabilities, which `nest-authz` forbids. The UI gates on this
   * and never computes it.
   */
  myCapabilities: permissionsSchema,
});
export type BookSummary = z.infer<typeof bookSummarySchema>;

/**
 * One row of `[SCR-07]`'s member section — a book's membership, resolved for display.
 *
 * `effectiveRole` is the role actually in force: the row's override if it has one, otherwise the
 * person's live account role. `inherited` says which of the two it was, because the design needs to
 * draw the difference — the picker shows an account member's role as a *default* the creator may
 * change, and a row that has been changed must not look identical to one that has not.
 *
 * Deliberately **not** the stored `BookMember`. That would make the client resolve `role ?? account
 * role` itself, which is the same re-derivation `myCapabilities` exists to prevent, and it would
 * need the account's member list loaded alongside every book to do it.
 */
/**
 * What a rendered member row can be — **wider than what can be stored**, by one value.
 *
 * `accountCreator` is never written to `Book.members`; it is synthesised at read time for the person
 * who created the account. `resolveBookAccess`'s first rung gives them every capability on every
 * book without a row (`[LOG-17]`: *"the account owner has every privilege on every book in their
 * account, by definition"*), which is the floor that stops anyone being locked out of their own
 * account — so they legitimately have no row to render, and a list built from rows alone omitted
 * someone who can read every entry in the book.
 *
 * That mattered once guests existed: `[SCR-07]`'s member section is what a book's creator consults
 * before inviting an outsider, and a list that under-reports who can see the book is wrong about the
 * one question it is there to answer. A security audit surfaced it; **the user chose the synthetic
 * row** over a line of general copy, because a name is checkable and a general statement is not.
 *
 * Two enums rather than one, deliberately: `bookMemberSchema.kind` must stay unable to express
 * `accountCreator`, or a write could store a row that outranks the ladder it is supposed to reflect.
 */
export const bookMemberSummaryKindSchema = z.enum(['account', 'guest', 'accountCreator']);
export type BookMemberSummaryKind = z.infer<typeof bookMemberSummaryKindSchema>;

export const bookMemberSummarySchema = z.object({
  userId: objectId,
  /** Resolved from the user record, exactly as `accountMemberSummarySchema.name` is. */
  name: z.string(),
  kind: bookMemberSummaryKindSchema,
  effectiveRole: roleSchema,
  inherited: z.boolean(),
  /**
   * The row cannot be removed or re-roled — it is not stored, so there is nothing to write.
   *
   * A flag rather than letting each client re-derive `kind === 'accountCreator'`: the book's own
   * creator is *also* undeletable (`bookSchema` refines that a creator is one of its members), so
   * this is genuinely one property with two causes, and `[SCR-07]` should gate on the property.
   */
  fixed: z.boolean(),
});
export type BookMemberSummary = z.infer<typeof bookMemberSummarySchema>;

/**
 * Adding an account member to a book, and changing the role they hold in it — `[SCR-07]`'s member
 * section and `[OVL-09]` step 2.
 *
 * `role: null` reverts to the inherited account role rather than removing the member; removal is a
 * `DELETE`, so that the two intents cannot be confused by an omitted field.
 *
 * There is no guest variant: a guest's row is written by **accepting an invitation**, never by a
 * request naming them. That keeps consent on the invitation and means no body can add a person to a
 * book they have not agreed to join.
 */
export const bookMemberInputSchema = z.object({
  userId: objectId,
  role: roleSchema.nullable().default(null),
});
export type BookMemberInput = z.infer<typeof bookMemberInputSchema>;

/** Changing one existing member's role in one book. `null` reverts to the inherited account role. */
export const bookMemberRoleInputSchema = z.object({ role: roleSchema.nullable() });
export type BookMemberRoleInput = z.infer<typeof bookMemberRoleInputSchema>;

/**
 * Editing a book's own capability matrix — `[SCR-08]`'s matrix block, transposed into `[SCR-07]`.
 *
 * `null` **re-attaches** the book to its account's matrix, which is what makes the inheritance
 * reversible: a creator who detached a book by accident can put it back rather than being left to
 * hand-copy the account's six switches per role and hope they match.
 */
export const bookPermissionsInputSchema = z.object({ perms: rolePermissionsSchema.nullable() });
export type BookPermissionsInput = z.infer<typeof bookPermissionsInputSchema>;

/**
 * `GET /shared-with-me` — the books someone reaches as a **guest**, outside any account they belong
 * to.
 *
 * **A separate endpoint rather than widening `GET /accounts`, and that is the security decision.**
 * A guest holds no `Account.members` row by definition, so the account list returns them nothing and
 * every account-scoped route 404s — which fails closed, correctly, but left an accepted invitation
 * with no way to reach the book it granted. The two repairs on the table were widening the account
 * list with a `guest: true` marker, or this. Widening would make one endpoint mean two different
 * things depending on a flag, and that endpoint *is* the account-membership boundary — every future
 * consumer would have to remember the flag or quietly treat a guest as a member. **The user chose
 * the separate endpoint**; `[OVL-01]`'s switcher composes the two lists, which is a UI concern and
 * the cheaper place to hold the complexity.
 *
 * `accountName` travels with each book because a guest has no account row to read it from, and a
 * bare book name is not enough to tell *whose* Groceries this is. Nothing else about the account
 * ships: no id-bearing member list, no balance, no capability matrix.
 */
export const sharedBookSummarySchema = bookSummarySchema.extend({
  /** The host account's name — context only. A guest is not a member of it. */
  accountName: z.string().min(1),
});
export type SharedBookSummary = z.infer<typeof sharedBookSummarySchema>;

/**
 * `GET /accounts/:accountId/books`.
 *
 * `month` is **required**: the server has no defensible default without a timezone, and silently
 * picking one would make a visible money figure wrong in a way nobody could see.
 */
export const booksQuerySchema = z.object({ month: monthString });
export type BooksQuery = z.infer<typeof booksQuerySchema>;
