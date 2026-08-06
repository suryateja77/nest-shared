import { z } from 'zod';

/**
 * [SCR-02]'s `authMode` — which identifier the caller is signing in with. Fixes the field's prefix,
 * keyboard type and hint copy on the client, and which lookup the server runs.
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
