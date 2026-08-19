import { z } from 'zod';
import { bookStatsSchema } from './book.js';
import {
  MAX_INVITES_PER_ACCOUNT,
  MAX_MEMBER_OPS_PER_SAVE,
  objectId,
  timestampsSchema,
} from './common.js';
import { accountInviteSchema, createInviteInputSchema } from './invite.js';
import { permissionsSchema, roleSchema, rolePermissionsSchema } from './role.js';

export const accountKindSchema = z.enum(['SHARED', 'PERSONAL']);
export type AccountKind = z.infer<typeof accountKindSchema>;

/**
 * How many accounts one person may belong to — a product ceiling set by the user.
 *
 * `[SCR-04]` is a short scrolling list and `[OVL-01]`'s switcher is a bottom sheet; neither is
 * designed for an unbounded set. It also bounds the one write in the service that creates its own
 * scope (`POST /accounts`), which has no membership to authorize against and would otherwise be
 * unlimited for any signed-in caller.
 *
 * Counted over membership rather than authorship, since an accepted invite also puts an account on
 * that list.
 */
export const MAX_ACCOUNTS_PER_USER = 5;

/**
 * A member of an account ([LOG-01]). `contact` is the email or phone the member was invited by —
 * it is what [SCR-08] renders under the name, and it is how a person is identified before they have
 * a user record. A pending invitee lives in `Invite` and only becomes a member once accepted, so
 * `userId` is required here.
 */
export const accountMemberSchema = z.object({
  userId: objectId,
  name: z.string().min(1).max(80),
  contact: z.string().min(1).max(120),
  role: roleSchema,
});
export type AccountMember = z.infer<typeof accountMemberSchema>;

/**
 * The account's fields, without the cross-field invariant.
 *
 * Kept separate because zod refuses `.pick()` / `.omit()` on an object schema carrying
 * refinements — the input schemas below derive from this, while `accountSchema` adds the check.
 */
const accountBaseSchema = z
  .object({
    id: objectId,
    name: z.string().min(1).max(80),
    kind: accountKindSchema,
    /**
     * The member who created this account — `[LOG-01]`'s `createdBy`, and the account's whole
     * authority model ([LOG-16]).
     *
     * **An id, not a name.** `[LOG-01]` writes `createdBy: string` and `[LOG-16]` compares it as
     * `account.createdBy === profile.name`, but that is the prototype having no user records to
     * point at — the same shorthand that makes its members a bare `{ name, contact, role }`. A name
     * is a mutable, non-unique label: the seed alone carries four Sharmas, and `profileSchema.name`
     * carries no uniqueness constraint. Every other authorship field in this contract is already an
     * id (`Entry.createdBy`, `Entry.updatedBy`), and `accountMemberSchema.userId` is required, so
     * there is always a real id to reference.
     *
     * `[SCR-08]`'s copy ("ONLY {FIRST}, WHO CREATED THIS ACCOUNT…") resolves the name by finding the
     * member whose `userId` matches, so no denormalised `createdByName` is needed.
     */
    createdBy: objectId,
    /**
     * The letter shown in the account's square chip on [SCR-04]. Stored rather than derived: the
     * prototype's personal account "My Money" carries the initial `A` (the owner's), so it does not
     * always follow from the account name.
     */
    initial: z.string().length(1),
    members: z.array(accountMemberSchema),
    /** The account's editable capability matrix ([SCR-08]). Seeded from `ROLE_PERMISSION_SEED`. */
    permissions: rolePermissionsSchema,
  })
  .merge(timestampsSchema);

/**
 * **The creator is always a member.** This is the account's floor of administrability, and it
 * replaces the exactly-one-`OWNER` refinement this schema used to carry.
 *
 * The old invariant guaranteed somebody always held `manageMembers`, because `OWNER`'s capabilities
 * sat outside the editable matrix. `createdBy` gives that guarantee more directly and more strongly:
 * [LOG-16] gates every account-administration action on `isCreator`, **deliberately overriding the
 * `Manage members` capability** — "an ADMIN who did not create the account still cannot edit it" —
 * so the creator's authority never depended on a matrix row in the first place and cannot be toggled
 * away on [SCR-08]. `createdBy` is set once at creation ([LOG-15]) and never changes.
 *
 * What still has to be true is that the creator is *reachable*: an account whose `createdBy` names
 * nobody in `members[]` has no one who can administer it, which is the same brick the old refinement
 * existed to prevent. Hence this check rather than none.
 *
 * The transitions this cannot see — removing or demoting the creator, and transferring ownership —
 * are server-enforced; see the `nest-authz` skill. A state schema validates the result, never the
 * step that produced it.
 */
export const accountSchema = accountBaseSchema.refine(
  (account) => account.members.some((member) => member.userId === account.createdBy),
  'An account’s creator must be one of its members',
);
export type Account = z.infer<typeof accountSchema>;

/**
 * `[OVL-15]`'s create sheet. Only `name`, `kind` and `initial` cross the wire.
 *
 * `createdBy`, `members` and `permissions` are absent by design — the server owns all three at
 * creation: `createdBy` and the single `members` entry both come from the authenticated session
 * ([LOG-15] creates the account and its creator in one write), and `permissions` is seeded from
 * `ROLE_PERMISSION_SEED`.
 *
 * A client that could supply any of them could hand itself an account it does not belong to, name
 * someone else as its creator, or seed a matrix that grants nothing — the states this model exists
 * to prevent.
 */
export const createAccountInputSchema = accountBaseSchema
  .pick({
    name: true,
    kind: true,
    initial: true,
  })
  .extend({
    /**
     * **Trimmed here, not only in the sheet.** `[LOG-15]` requires "a non-empty **trimmed** name",
     * and a bare `.min(1)` accepts `"   "`. That is not cosmetic: `[OVL-17]`'s delete confirmation
     * unlocks on `dangerText.trim() === account.name.trim()`, so an all-whitespace account name
     * makes an **empty** input satisfy the typed confirmation that exists to slow a destructive act
     * down. Trimming at the contract closes it for every client, present and future.
     */
    name: z.string().trim().min(1).max(80),
    /**
     * The invites `[OVL-15]` queued in its **WILL BE INVITED** list, sent with the account rather
     * than as follow-up requests.
     *
     * `[LOG-15]` makes creation **one atomic transaction** — account, books and
     * `invitesByAcct[id]` all land in a single `setState`. Splitting it into
     * `POST /accounts` + N × `POST /accounts/:id/invites` would let the third invite fail after the
     * account exists, leaving a half-built invite list and no way to repair it: `[SCR-08]`, the
     * screen that manages invites, is not built yet. One request cannot half-succeed.
     *
     * Capped at family scale. Uncapped, one request is an unbounded write amplification, and
     * `[SCR-08]`'s pending-invite list is designed as a handful of rows, not a mailing list.
     */
    invites: z.array(createInviteInputSchema).max(MAX_INVITES_PER_ACCOUNT).default([]),
  });
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

/**
 * Renaming an account, and editing its capability matrix ([SCR-08]).
 *
 * `members` is deliberately absent **here**, and `accountManageSaveInputSchema` extends this schema
 * to add it for `[SCR-08]`'s deferred save (2026-08-19). This comment used to say membership *"goes
 * through the invite and member-management routes, which carry their own authorization, not through
 * a general account update"* — the authorization half is still true and is why the extension gates
 * every staged row per target rather than relying on the one gate at the door. Keeping the base
 * schema membership-free means only the screen that asks for it can express one.
 */
export const updateAccountInputSchema = accountBaseSchema
  .pick({ name: true, initial: true, permissions: true })
  .partial()
  .extend({
    /**
     * **Trimmed here too, for the same reason `createAccountInputSchema` trims.**
     *
     * `.pick()` carries `accountBaseSchema`'s bare `.min(1)` through unchanged, so before this
     * override a rename to `"   "` parsed successfully and stored an all-whitespace name. That is
     * the precise state `createAccountInputSchema`'s comment above exists to prevent: `[OVL-17]`
     * unlocks Delete on `dangerText.trim() === account.name.trim()`, so a whitespace name makes an
     * **empty** typed confirmation satisfy the gate that exists to slow a destructive act down.
     *
     * Create was trimmed and update was not, which meant the guarantee held only until the first
     * rename. Stays `.optional()` because the whole input is a `PATCH`.
     */
    name: z.string().trim().min(1).max(80).optional(),
  });
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;

/**
 * A member as the account *list* renders them — name and role only.
 *
 * `contact` is deliberately absent. It is a member's phone number or email address, and the frozen
 * design renders it on exactly one screen: `[SCR-08]`, which is the `manageMembers` screen. Sending
 * it with the account list would hand every member's contact details to every other member,
 * including a `TEEN`, to draw `[SCR-05]`'s overlapping avatars.
 *
 * `role` is the plain `roleSchema` — since ownership left the role enum, the four chips [SCR-08]
 * renders are exactly the roles a stored member can hold, so no second enum is needed here.
 */
export const accountMemberSummarySchema = accountMemberSchema.pick({
  userId: true,
  name: true,
  role: true,
});
export type AccountMemberSummary = z.infer<typeof accountMemberSummarySchema>;

/**
 * `GET /accounts` — the account list behind `[SCR-04]` and the `[OVL-01]` switcher.
 *
 * Deliberately **not** `Account`. Two things are withheld and one is added:
 *
 * - **No `contact`** on members — see `accountMemberSummarySchema`.
 * - **No `permissions` matrix.** Shipping it would force the client to find itself in `members[]`,
 *   read its own role and index the matrix — that is the client re-deriving capabilities, which
 *   `nest-authz` forbids.
 * - **`myCapabilities`** instead: the caller's own six capabilities, already resolved server-side
 *   against the account's stored matrix. The UI gates on this and never computes it.
 *
 * **`createdBy` is included** ([LOG-16]). It is the one fact `myCapabilities` cannot stand in for:
 * a non-creating ADMIN and the creator hold identical capabilities under the seeded matrix, yet only
 * the creator gets [SCR-08]'s editable variant, and only the creator sees `Delete account` where
 * everyone else sees `Leave account`. Not a disclosure — `members[]` already carries every member's
 * `userId`, so this names one of them rather than revealing a new one.
 */
export const accountSummarySchema = accountBaseSchema
  .pick({ id: true, name: true, kind: true, initial: true, createdBy: true })
  .extend({
    members: z.array(accountMemberSummarySchema),
    myCapabilities: permissionsSchema,
    /**
     * Derived per `[LOG-05]`'s "account totals = Σ bookStats over books where book.acct === acctId",
     * for `[SCR-04]`'s right-aligned balance and `[OVL-01]`'s per-account figure. Never stored.
     *
     * **Nullable, and null means "not permitted to see it"** rather than "no books". `GET /accounts`
     * is the one route with no capability gate — a member must be able to find the accounts they
     * belong to even when an admin has switched `View entries` off their role on `[SCR-08]` — so a
     * balance, which is entry-derived, cannot be unconditional here. Null rather than an absent key
     * so the two states stay distinguishable in the type.
     */
    stats: bookStatsSchema.nullable(),
    /** Book count for `[SCR-04]`'s meta line and `[OVL-01]`'s `{KIND} · {n} BOOKS`. Not entry-derived, so never withheld. */
    bookCount: z.number().int().nonnegative(),
  });
export type AccountSummary = z.infer<typeof accountSummarySchema>;

/**
 * `GET /accounts/:accountId` — everything `[SCR-08]` **Manage account** renders, in one payload.
 *
 * Deliberately **not** `accountSummarySchema`. `[SCR-08]` is the one screen the frozen design draws a
 * member's `contact` on, and the one screen that edits the capability matrix, so both are present
 * here and withheld from the list route. Read this schema's presence as the licence for that
 * disclosure and nothing wider: reach for `accountSummarySchema` anywhere else.
 *
 * **Membership is the gate, not a capability.** `[SCR-08]` has two variants keyed on `createdBy`
 * (`[LOG-16]`), and the read-only one is open to every member — so this cannot be gated on
 * `manageMembers` (which `[LOG-16]` deliberately overrides) nor on `viewEntries` (which would tie a
 * members screen to entry rights). The caller still gets `myCapabilities`, resolved server-side, so
 * the client never indexes the matrix to find its own rights even though it now holds the matrix.
 *
 * Built from `accountBaseSchema` rather than `accountSchema` because zod refuses `.extend()` on a
 * refined schema; the creator-is-a-member invariant is re-applied below, since a response is still a
 * state and the floor of administrability should not go unchecked just because it crossed a wire.
 */
export const accountManagementSchema = accountBaseSchema
  .extend({
    /** The caller's own six capabilities, already resolved against the matrix ([nest-authz]). */
    myCapabilities: permissionsSchema,
    /**
     * `[SCR-08]` item 5's **PENDING INVITES** rows and their `n WAITING` count. Only pending and
     * revoked invites are the screen's business — an accepted one is a member row instead — but the
     * status is carried rather than filtered so `[OVL-16]`'s revoke → undo round trip is a status
     * flip the client can render, not a row that vanishes and reappears.
     */
    invites: z.array(accountInviteSchema).max(MAX_INVITES_PER_ACCOUNT),
    /**
     * `[OVL-17]`'s facts table, computed per request and **never stored** (`[LOG-05]`).
     *
     * **Both counts are per-viewer**, filtered through `[LOG-17]`'s `inBook` exactly as
     * `GET /accounts` already filters `bookCount`. One pair of numbers therefore serves both danger
     * modes correctly without a second field: the creator short-circuits `inBook` and sees every
     * book, which is what `BOOKS DELETED` / `ENTRIES DELETED` mean, and a non-creator sees only their
     * own, which is exactly what `BOOKS YOU LOSE` means.
     *
     * They are counts, not balances — `[OVL-17]` names no money, so no capability gate is needed and
     * neither is nullable.
     */
    facts: z.object({
      bookCount: z.number().int().nonnegative(),
      entryCount: z.number().int().nonnegative(),
    }),
  })
  .refine(
    (account) => account.members.some((member) => member.userId === account.createdBy),
    'An account’s creator must be one of its members',
  );
export type AccountManagement = z.infer<typeof accountManagementSchema>;

/* --------------------------------------------------------------------------------------------
   [SCR-08]'s deferred save — DECISIONS.md, 2026-08-19
   -------------------------------------------------------------------------------------------- */

/** One member's role, as a batch item. Non-nullable: an account role is inherited from nowhere, so
 *  `[LOG-16]` has no "follows" state for `null` to mean. */
export const accountMemberRoleChangeSchema = z.object({ userId: objectId, role: roleSchema });
export type AccountMemberRoleChange = z.infer<typeof accountMemberRoleChangeSchema>;

/** One pending invitation's role — `[OVL-16]` in invite mode writes this, not a member row. */
export const accountInviteRoleChangeSchema = z.object({ inviteId: objectId, role: roleSchema });
export type AccountInviteRoleChange = z.infer<typeof accountInviteRoleChangeSchema>;

/**
 * The two membership operations `[SCR-08]` can stage.
 *
 * **There is no `add`.** An account gains people only by invitation and acceptance — `[LOG-15]`'s
 * consent rule, and why no request body can name somebody into an account. `[SCR-07]`'s book batch
 * does have one, because adding an existing account member to a book crosses no tenancy boundary.
 */
export const accountMemberChangesSchema = z.object({
  setRole: z.array(accountMemberRoleChangeSchema).max(MAX_MEMBER_OPS_PER_SAVE).default([]),
  remove: z.array(objectId).max(MAX_MEMBER_OPS_PER_SAVE).default([]),
});
export type AccountMemberChanges = z.infer<typeof accountMemberChangesSchema>;

/** Invitations staged on `[SCR-08]` — `[OVL-06]` to send, `[OVL-16]` to re-role, the pending row's
 *  REVOKE to withdraw. RESEND is deliberately absent: `[LOG-16]` makes it a toast with no request,
 *  so there is nothing to stage. */
export const accountInviteChangesSchema = z.object({
  send: z.array(createInviteInputSchema).max(MAX_INVITES_PER_ACCOUNT).default([]),
  setRole: z.array(accountInviteRoleChangeSchema).max(MAX_INVITES_PER_ACCOUNT).default([]),
  revoke: z.array(objectId).max(MAX_INVITES_PER_ACCOUNT).default([]),
});
export type AccountInviteChanges = z.infer<typeof accountInviteChangesSchema>;

const EMPTY_ACCOUNT_MEMBER_CHANGES: AccountMemberChanges = { setRole: [], remove: [] };
const EMPTY_ACCOUNT_INVITE_CHANGES: AccountInviteChanges = { send: [], setRole: [], revoke: [] };

/**
 * `PATCH /accounts/:accountId` — everything `[SCR-08]`'s docked Save commits, in one request: the
 * name, the capability matrix, and every staged person-level change.
 *
 * **This is the half that overrides frozen `[LOG-16]`** — *"Role changes are immediate and not part
 * of the dirty bar — they are per-person facts, not a form."* The user overrode it explicitly after
 * device testing, because the screen ships a **Discard** button and the two cannot both be honest: a
 * write that already landed is not discardable. `DECISIONS.md` carries the reasoning, and the design
 * export will keep re-asserting the original — do not "fix" this back.
 *
 * `updateAccountInputSchema`'s own comment said membership *"goes through the invite and member-
 * management routes, which carry their own authorization, not through a general account update"*.
 * The authorization half of that is still true and is why this is not a widening of one gate:
 * `[LOG-16]` gates the whole screen on `requireAccountCreator`, and every staged row is additionally
 * checked per target — self, the account creator, and non-members are each refused individually.
 *
 * See `bookSettingsSaveInputSchema` for why these are operations rather than a desired end state.
 */
export const accountManageSaveInputSchema = updateAccountInputSchema
  /**
   * **`initial` is dropped here, at the contract.**
   *
   * `updateAccountInputSchema` carries it, but the live `PATCH /accounts/:accountId` hand-rolls a
   * narrower body specifically to exclude it — *"it was the one request field in this module the
   * client could set that the server should own"*. `[LOG-16]` has a rename **re-derive** the initial
   * and `[SCR-08]` offers no control for it, so a payload that can set the two independently can
   * express a state no screen can produce: a chip reading `Z` on an account called *Sharma Family*.
   *
   * Omitted rather than left for the handler to strip a second time, because this schema *is* the
   * route body — which is exactly what `updateBookInputSchema`'s own comment warns about: *"a
   * contract that can express a change no screen offers is a route waiting to be written against
   * it."* Found by `contract-guardian` before this shipped.
   */
  .omit({ initial: true })
  .extend({
    members: accountMemberChangesSchema.default(EMPTY_ACCOUNT_MEMBER_CHANGES),
    invites: accountInviteChangesSchema.default(EMPTY_ACCOUNT_INVITE_CHANGES),
  })
  /** One person, one intent per save — see `bookSettingsSaveInputSchema` for why an ambiguous pair
   *  is refused rather than ordered. */
  .refine(
    (value) => {
      const touched = [...value.members.setRole.map((change) => change.userId), ...value.members.remove];
      return new Set(touched).size === touched.length;
    },
    { message: 'Each member may appear in only one change per save', path: ['members'] },
  )
  /** The same for invitations, which may be re-roled *or* revoked in one save, never both. */
  .refine(
    (value) => {
      const touched = [
        ...value.invites.setRole.map((change) => change.inviteId),
        ...value.invites.revoke,
      ];
      return new Set(touched).size === touched.length;
    },
    { message: 'Each invitation may appear in only one change per save', path: ['invites'] },
  )
  /**
   * **A save must actually ask for something.**
   *
   * The hand-rolled body this replaced carried a *"Nothing to update"* refinement, and dropping it
   * would have been a silent weakening: `members` and `invites` are `.default()`ed, so a bare `{}`
   * parses cleanly and would reach the handler as a full authorize-hydrate-save round trip that
   * changes nothing. `[SCR-08]`'s bar is passive when clean and never sends, so an empty body is a
   * client defect — and the cheapest place to catch one is the contract.
   */
  .refine(
    (value) =>
      value.name !== undefined ||
      value.permissions !== undefined ||
      value.members.setRole.length > 0 ||
      value.members.remove.length > 0 ||
      value.invites.send.length > 0 ||
      value.invites.setRole.length > 0 ||
      value.invites.revoke.length > 0,
    'Nothing to update',
  );
export type AccountManageSaveInput = z.infer<typeof accountManageSaveInputSchema>;

/**
 * What a **client** may send — the same schema from the input side, before zod applies the
 * `members`/`invites` defaults. See `BookSettingsSaveBody` for why the two sides need separate names:
 * a handler can rely on the groups existing, a caller must be able to omit them, and typing the
 * request with the output type would force every caller to send empty groups it does not mean.
 */
export type AccountManageSaveBody = z.input<typeof accountManageSaveInputSchema>;
