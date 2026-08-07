import { z } from 'zod';
import { bookStatsSchema } from './book.js';
import { objectId, timestampsSchema } from './common.js';
import { createInviteInputSchema } from './invite.js';
import { permissionsSchema, roleSchema, rolePermissionsSchema } from './role.js';

export const accountKindSchema = z.enum(['SHARED', 'PERSONAL']);
export type AccountKind = z.infer<typeof accountKindSchema>;

/**
 * Family scale, not an arbitrary round number: `[SCR-04]`'s account rows read `4 MEMBERS`, and
 * `[OVL-17]`'s delete confirm names the member count in a sentence. A household that needs more
 * than this is not the product `PRODUCT-SPEC.md` describes.
 */
export const MAX_INVITES_PER_ACCOUNT = 20;

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
 * `members` is deliberately absent: membership changes go through the invite and member-management
 * routes, which carry their own authorization, not through a general account update.
 */
export const updateAccountInputSchema = accountBaseSchema
  .pick({ name: true, initial: true, permissions: true })
  .partial();
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
