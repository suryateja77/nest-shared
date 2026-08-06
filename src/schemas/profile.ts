import { z } from 'zod';
import { objectId, timestampsSchema } from './common.js';

/**
 * The signed-in user's own profile ([LOG-01] `Profile`, rendered on [SCR-12] and edited on
 * [SCR-12b]). This is the user record as its owner sees it — other members see only the name,
 * contact and role carried on `AccountMember`.
 */
export const profileSchema = z
  .object({
    id: objectId,
    name: z.string().min(1).max(80),
    /** [LOG-01]'s `user` — the `@handle` shown in the USERNAME row. Stored without the `@`. */
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(/^[a-z0-9._]+$/, 'Lowercase letters, digits, dots and underscores only'),
    /**
     * Both identifiers are nullable because [REQ-2] allows signing up with **either** email or
     * phone — a user who joined by phone has no email until they add one.
     */
    email: z.email().nullable(),
    phone: z.string().min(1).max(20).nullable(),
    /** `null` until a photo is set; [SCR-12] falls back to a letter avatar ([OVL-03]). */
    avatarUrl: z.url().nullable(),
  })
  .merge(timestampsSchema);
export type Profile = z.infer<typeof profileSchema>;

/**
 * `PATCH /profile` — the two [SCR-12b] fields that carry no other invariant and can be written
 * directly.
 *
 * Deliberately narrower than `profileSchema` itself: `email` and `phone` are sign-in identifiers,
 * so a payload that included them would let a route compile against a shape it must never actually
 * write from — the server has to verify a new identifier by OTP before it takes effect (see
 * `changeIdentifier*` below). `avatarUrl` is a photo upload, out of scope for this feature and with
 * no route to write it yet ([OVL-03]). Keeping both off this type, rather than trusting a handler
 * to ignore them, is what makes "written from this payload" impossible instead of merely unwise.
 */
export const updateProfileDetailsInputSchema = profileSchema
  .pick({ name: true, username: true })
  .partial();
export type UpdateProfileDetailsInput = z.infer<typeof updateProfileDetailsInputSchema>;
