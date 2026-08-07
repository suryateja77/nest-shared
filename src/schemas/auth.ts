import { z } from 'zod';
import { profileSchema } from './profile.js';

/**
 * [SCR-02]'s `authMode` — which identifier the caller is signing in with. Fixes the field's prefix,
 * keyboard type and hint copy on the client, and which lookup the server runs.
 *
 * Named for OTP because that is the flow it was written for, and **deliberately reused** by the
 * password schemas below rather than duplicated under a second name: it answers one question —
 * "phone or email?" — and two names for it would be free drift the first time one gained a
 * channel the other did not.
 */
export const otpChannelSchema = z.enum(['phone', 'email']);
export type OtpChannel = z.infer<typeof otpChannelSchema>;

/** [SCR-03] fixes the code at exactly 4 digits and auto-submits on the 4th. */
export const OTP_CODE_LENGTH = 4;
const otpCodeSchema = z
  .string()
  .regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`), `Enter the ${OTP_CODE_LENGTH}-digit code`);

/** India-only for v1, matching [SCR-02]'s fixed `+91` prefix — no country selector is drawn. */
const phoneIdentifierSchema = z.string().regex(/^\d{10}$/, 'Enter a 10-digit phone number');
const emailIdentifierSchema = z.email();

/**
 * Tied to `channel` rather than one loose `identifier` string, so a phone-shaped value can never be
 * sent down the email path or vice versa — [SCR-02] never lets the two mix.
 */
export const sendOtpInputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('phone'), identifier: phoneIdentifierSchema }),
  z.object({ channel: z.literal('email'), identifier: emailIdentifierSchema }),
]);
export type SendOtpInput = z.infer<typeof sendOtpInputSchema>;

/**
 * `resendAfterSeconds` drives [SCR-03]'s `RESEND IN 00:24` countdown — the server names its own
 * throttle window rather than the client assuming one it does not enforce.
 */
export const sendOtpResultSchema = z.object({
  resendAfterSeconds: z.number().int().positive(),
});
export type SendOtpResult = z.infer<typeof sendOtpResultSchema>;

export const verifyOtpInputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('phone'), identifier: phoneIdentifierSchema, code: otpCodeSchema }),
  z.object({ channel: z.literal('email'), identifier: emailIdentifierSchema, code: otpCodeSchema }),
]);
export type VerifyOtpInput = z.infer<typeof verifyOtpInputSchema>;

/* -------------------------------------------------------------------------------------------------
 * Password sign-up / sign-in — the interim flow.
 *
 * `TECH_STACK.md` defers the OTP vendor, and `[SCR-02]`'s frozen blurb reads "No password to
 * remember" — so this is a **stated deviation from the frozen design**, added on the user's
 * instruction to make sign-in work before a real `OtpProvider` exists. The OTP schemas above are
 * kept rather than replaced: when the vendor lands, that flow is already contracted and these
 * become the fallback rather than a rewrite.
 * ---------------------------------------------------------------------------------------------- */

/**
 * `128` is a real bound, not a formality. The server hashes with scrypt, whose work is a function of
 * the input it is handed — an unbounded password field is a cheap way to make one request burn CPU
 * on a service that has no rate limiter yet. `8` is the floor rather than a composition rule
 * (no "one symbol, one digit"): length is the property that actually resists guessing, and
 * composition rules push people towards `Password1!`.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * The same 1–80 bound `profileSchema.name` carries, read off that schema rather than restated, so
 * a name accepted at sign-up can never be one the profile contract would reject.
 *
 * `.trim()` runs **before** the bound, which is the whole reason this is not just
 * `profileSchema.shape.name`: `"   "` satisfies `min(1)` untrimmed, and `[SCR-04]`'s greeting and
 * every member row would then render a blank where a person's name belongs.
 */
const signUpNameSchema = z
  .string()
  .trim()
  .pipe(profileSchema.shape.name);

/**
 * `POST /auth/sign-up`. No `username` field: `[REQ-2]` makes it part of the profile, but nothing in
 * `[SCR-01]`–`[SCR-03]` collects one and adding a third field to a two-field screen is new surface
 * on a frozen design. The server derives one from `name` and `[SCR-12b]` already edits it
 * (`updateProfileDetailsInputSchema`).
 */
export const signUpInputSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('phone'),
    identifier: phoneIdentifierSchema,
    password: passwordSchema,
    name: signUpNameSchema,
  }),
  z.object({
    channel: z.literal('email'),
    identifier: emailIdentifierSchema,
    password: passwordSchema,
    name: signUpNameSchema,
  }),
]);
export type SignUpInput = z.infer<typeof signUpInputSchema>;

/**
 * Sign-in deliberately does **not** reuse `passwordSchema`.
 *
 * `passwordSchema` is a *policy* — what a new password must be. Applying a policy at the login gate
 * means the day `PASSWORD_MIN_LENGTH` rises, every existing user holding a shorter password stops
 * being able to sign in, and the error they get is a field-validation complaint rather than a route
 * to reset it. What sign-in actually needs is only the DoS bound: something was typed, and it is not
 * megabytes of it.
 */
const signInPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/**
 * `POST /auth/sign-in`. Shape validation only — it says nothing about whether the identifier
 * exists, and the route's single "incorrect" message is what keeps `[LOG-12]`'s existence rule
 * intact on the way back.
 */
export const signInInputSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('phone'),
    identifier: phoneIdentifierSchema,
    password: signInPasswordSchema,
  }),
  z.object({
    channel: z.literal('email'),
    identifier: emailIdentifierSchema,
    password: signInPasswordSchema,
  }),
]);
export type SignInInput = z.infer<typeof signInInputSchema>;
