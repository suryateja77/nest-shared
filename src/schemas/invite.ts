import { z } from 'zod';
import { objectId, timestampsSchema } from './common.js';
import { roleSchema } from './role.js';

/**
 * [LOG-01] gives `Invite.status` as only `'pending'`, because the prototype drops an invite once it
 * resolves. The extra terminal states are real: [SCR-08] has a revoke `×`, and [SCR-04] offers
 * Accept and Decline.
 */
export const inviteStatusSchema = z.enum(['pending', 'accepted', 'declined', 'revoked']);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/**
 * Module-private, for the reason `bookBaseSchema` and `accountBaseSchema` are: zod refuses
 * `.pick()`/`.omit()` on an object carrying a refinement, and an exported invariant-free alias of
 * the entity would let a caller parse an `Invite` that had skipped `bookIdAndNameAgree`. It exists
 * only so the projections below can be cut from it.
 */
const inviteBaseSchema = z
  .object({
    id: objectId,
    accountId: objectId,
    accountName: z.string().min(1),
    inviterName: z.string().min(1),
    /** Phone number or email the invite is addressed to. Normalised per [LOG-12]'s `dirKey`. */
    contact: z.string().min(1).max(120),
    /**
     * The directory name resolved from `contact`, or `null` when unknown ([LOG-12]). Drives the
     * matched name in [OVL-06] and the initial-vs-generic avatar on [SCR-08]'s pending rows.
     *
     * Resolution must not become a lookup oracle: [LOG-12] requires it "must not leak whether a
     * stranger is a Nest user beyond what the invite flow needs."
     */
    name: z.string().min(1).max(80).nullable(),
    /**
     * `[OVL-15]`'s `THEY JOIN AS` pills and `[OVL-16]`'s role rows — ADMIN / EDITOR / VIEWER / TEEN,
     * defaulting to EDITOR ([LOG-15]).
     *
     * An invite confers a role, never ownership: `createdBy` is set at creation and never changes
     * ([LOG-16]), so there is no value here that could escalate the invitee into administering the
     * account.
     */
    role: roleSchema,
    status: inviteStatusSchema,
    /**
     * The book this invitation is *to*, or `null` for an invitation into the account itself.
     *
     * One entity for both, because they are the same object with the same lifecycle — addressed by
     * contact, resolved through `[LOG-12]`, pending until accepted, declined or revoked — and
     * `[SCR-04]`'s inbox renders them in one list. A parallel `BookInvite` would duplicate the
     * contact normalisation, the status machine, the accept/decline routes and the inbox query, and
     * every one of those is a place for the two to drift.
     *
     * **What accepting does differs entirely, and that is the point of the discriminator.** A `null`
     * `bookId` writes an `Account.members` row, and the invitee gains every book in the account they
     * are added to. A non-null one writes a single `kind: 'guest'` row on that book and grants
     * nothing else — no account membership, no other book, no account balance.
     *
     * `accountId` stays populated either way: a book invitation still has to name the account for
     * `[SCR-04]` to say *"…to Groceries in Sharma Family"*, and the resolver needs it to load the
     * account whose matrix the book may still be inheriting.
     */
    bookId: objectId.nullable(),
    /** The book's name, denormalised for `[SCR-04]`'s row. `null` exactly when `bookId` is. */
    bookName: z.string().min(1).max(60).nullable(),
  })
  .merge(timestampsSchema);

/**
 * The two book fields are set together or not at all — the discriminator and its denormalised label
 * cannot disagree. A row with a `bookId` and no `bookName` would render `[SCR-04]`'s sentence with a
 * hole in it; a row with a `bookName` and no `bookId` would grant account membership while telling
 * the invitee they were joining one book.
 */
const bookIdAndNameAgree = (invite: { bookId: string | null; bookName: string | null }): boolean =>
  (invite.bookId === null) === (invite.bookName === null);
const BOOK_FIELDS_AGREE =
  'A book invitation carries both bookId and bookName, an account invitation neither';

export const inviteSchema = inviteBaseSchema.refine(bookIdAndNameAgree, {
  message: BOOK_FIELDS_AGREE,
  path: ['bookName'],
});
export type Invite = z.infer<typeof inviteSchema>;

/**
 * `role` is set by the inviter and is **not** re-accepted from the invitee on acceptance —
 * otherwise anyone could join as ADMIN. `name` is server-resolved, never client-supplied.
 */
export const createInviteInputSchema = inviteBaseSchema.pick({ contact: true, role: true }).extend({
  /**
   * A contact must actually be a phone number or an email address.
   *
   * `inviteSchema.contact` is `z.string().max(120)` because it also types **stored** rows, including
   * legacy ones. On the way *in* that is too loose to be safe: the server derives a `contactKey` by
   * looking for an `@` and otherwise stripping non-digits, so
   * `"9876543210 — overdue, pay at nest-billing.example"` normalises to a key that matches the real
   * victim while `contact` keeps the whole attacker-written string — and `contact` is what
   * `[SCR-08]`'s pending-invite row renders verbatim. That turns a correctly-addressed invite into a
   * delivery channel for arbitrary text.
   *
   * Ten digits is the Indian mobile length the design assumes throughout (`[SCR-02]`'s placeholder
   * is `98450 22118`). This validates *shape*, not reachability — nothing here proves the person exists,
   * which is deliberate: `[LOG-12]` forbids the lookup that would.
   *
   * **The normalised key must be exactly ten digits, not merely at least ten.** This used to be a floor,
   * so that a `+91` or `0` prefix still passed — but the server's `contactKeyOf` keeps the **last** ten
   * digits, and a security audit found what those two rules do together: a trailing typo silently
   * re-addresses the invite to a different subscriber. `"9845022118"` and `"98450221180"` both passed,
   * and the second resolves to key `8450221180` — a stranger, who then sees *"Ananya invited you to
   * Sharma Family"* with no contact on the row to tell them it is not for them (`myInviteSchema` omits
   * `contact`), while `[SCR-08]` shows the inviter their invite was accepted. One mistyped character was
   * a cross-tenant membership grant, confirmed as success on both screens.
   *
   * So the prefixes are consumed explicitly instead: one optional `+91`, `91` or `0`, then exactly ten
   * digits. Same key space `phoneIdentifierSchema` already requires exactly ten of.
   */
  contact: z
    .string()
    .trim()
    .max(120)
    .refine(
      (value) =>
        value.includes('@')
          ? z.email().safeParse(value).success
          : /**
             * The **whole** string must look like a phone number, not merely contain ten digits.
             * Counting digits alone accepts
             * `"9876543210 — overdue, pay at nest-billing.example"`, which is exactly the payload
             * this rule exists to refuse: it normalises to the victim's real `contactKey` while
             * `contact` — the value `[SCR-08]` renders verbatim — keeps the attacker's sentence.
             * Separators are allowed because `[SCR-02]`'s own placeholder is `98450 22118`.
             */
            /^\+?[\d\s\-()]+$/.test(value) &&
            /** One optional country/trunk prefix, then exactly the ten digits `contactKeyOf` will keep. */
            /^(?:91|0)?\d{10}$/.test(value.replace(/\D/g, '')),
      'Enter a valid phone number or email address',
    ),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

/**
 * An account's own pending-invite rows ([SCR-08]) — the `Invite` of [LOG-01]. Scoped to an account
 * the caller can already see, so it carries the contact.
 */
export const accountInviteSchema = inviteBaseSchema.pick({
  id: true,
  contact: true,
  name: true,
  role: true,
  status: true,
});
export type AccountInvite = z.infer<typeof accountInviteSchema>;

/**
 * An invitation addressed to the signed-in user ([SCR-04]) — `MyInvite` in [LOG-01].
 *
 * Deliberately without `contact`: the recipient already knows their own, and omitting it keeps the
 * projection minimal.
 */
export const myInviteSchema = inviteBaseSchema.pick({
  id: true,
  accountId: true,
  accountName: true,
  inviterName: true,
  role: true,
  status: true,
  /**
   * Carried so `[SCR-04]`'s row can say which of the two invitations this is. The sentence the
   * design specifies — *bold inviter*, *bold account name* — is ambiguous once book invitations
   * exist: *"Rohit invited you to Sharma Family"* reads identically whether the invitee is about to
   * gain the whole account or one book, and those grant very different access to a family's money.
   * The recipient has to be able to tell before they press Accept.
   */
  bookId: true,
  bookName: true,
});
export type MyInvite = z.infer<typeof myInviteSchema>;

/**
 * Inviting a guest to one book — `[OVL-06]`, transposed into `[SCR-07]`.
 *
 * Identical body to `createInviteInputSchema`, and deliberately a **separate named export** rather
 * than a reuse: the two are validated by different resolvers against different authorities
 * (`requireAccountCreator` for an account invitation, the book's own `createdBy` for this one), and
 * the book is named by the route path, never by the body. Giving each route its own input type keeps
 * that difference visible at every call site instead of resting on which URL happened to be used.
 */
export const createBookInviteInputSchema = createInviteInputSchema;
export type CreateBookInviteInput = z.infer<typeof createBookInviteInputSchema>;
