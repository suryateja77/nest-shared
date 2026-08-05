import { z } from 'zod';
import { objectId, timestampsSchema } from './common.js';
import { assignableRoleSchema } from './role.js';

/**
 * [LOG-01] gives `Invite.status` as only `'pending'`, because the prototype drops an invite once it
 * resolves. The extra terminal states are real: [SCR-08] has a revoke `×`, and [SCR-04] offers
 * Accept and Decline.
 */
export const inviteStatusSchema = z.enum(['pending', 'accepted', 'declined', 'revoked']);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const inviteSchema = z
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
    /** Assignable roles only — an invite can never confer `OWNER`. */
    role: assignableRoleSchema,
    status: inviteStatusSchema,
  })
  .merge(timestampsSchema);
export type Invite = z.infer<typeof inviteSchema>;

/**
 * `role` is set by the inviter and is **not** re-accepted from the invitee on acceptance —
 * otherwise anyone could join as ADMIN. `name` is server-resolved, never client-supplied.
 */
export const createInviteInputSchema = inviteSchema.pick({
  contact: true,
  role: true,
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

/**
 * An account's own pending-invite rows ([SCR-08]) — the `Invite` of [LOG-01]. Scoped to an account
 * the caller can already see, so it carries the contact.
 */
export const accountInviteSchema = inviteSchema.pick({
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
export const myInviteSchema = inviteSchema.pick({
  id: true,
  accountId: true,
  accountName: true,
  inviterName: true,
  role: true,
  status: true,
});
export type MyInvite = z.infer<typeof myInviteSchema>;
