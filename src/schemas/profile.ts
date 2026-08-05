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
 * [SCR-12b] edits exactly the four detail rows plus the photo.
 *
 * Changing `email` or `phone` changes a sign-in identifier, so the server must verify the new one
 * by OTP before it takes effect — it cannot simply be written from this payload.
 */
export const updateProfileInputSchema = profileSchema
  .pick({ name: true, username: true, email: true, phone: true, avatarUrl: true })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
