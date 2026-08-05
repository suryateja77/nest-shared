import { z } from 'zod';
import { objectId, timestampsSchema } from './common.js';
import { roleSchema, rolePermissionsSchema } from './role.js';

export const accountKindSchema = z.enum(['SHARED', 'PERSONAL']);
export type AccountKind = z.infer<typeof accountKindSchema>;

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
 * An account holds **exactly one** `OWNER` — the member who created it, shared or personal.
 *
 * This is the account's floor of administrability. `OWNER`'s capabilities are constants outside the
 * editable matrix, so guaranteeing one member always holds the role guarantees `manageMembers` is
 * always held by somebody. Without it an account can be bricked from inside the designed UI:
 * [SCR-08] lets an admin toggle `Manage members` off the ADMIN row, and if no role in the matrix
 * grants it and no owner exists, membership can never be changed again.
 *
 * Zero owners is therefore invalid, which deliberately rejects the prototype's shared-account
 * fixture (two ADMINs, no owner) — that seed never exercises account creation. More than one is
 * invalid too: `OWNER` is not assignable, so a second one cannot be arrived at legitimately.
 *
 * The transitions this cannot see — removing or demoting the owner, and transferring the role —
 * are server-enforced; see the `nest-authz` skill.
 */
export const accountSchema = accountBaseSchema.refine(
  (account) => account.members.filter((member) => member.role === 'OWNER').length === 1,
  'An account must have exactly one OWNER',
);
export type Account = z.infer<typeof accountSchema>;

/**
 * `members` and `permissions` are absent by design — the server owns both at creation:
 * `members` becomes exactly `[{ creator, role: 'OWNER' }]` from the authenticated session, and
 * `permissions` is seeded from `ROLE_PERMISSION_SEED`.
 *
 * A client that could supply either could hand itself an account with no owner, or one whose matrix
 * grants nothing — the two states this model exists to prevent.
 */
export const createAccountInputSchema = accountBaseSchema.pick({
  name: true,
  kind: true,
  initial: true,
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
