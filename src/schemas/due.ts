import { z } from 'zod';
import { dateOnlyString, moneyAmount, objectId, timestampsSchema } from './common.js';

export const dueDirectionSchema = z.enum(['lent', 'borrowed']);
export type DueDirection = z.infer<typeof dueDirectionSchema>;

export const dueStatusSchema = z.enum(['active', 'settled']);
export type DueStatus = z.infer<typeof dueStatusSchema>;

/**
 * Repeat options offered by the due editor ([OVL-10]) — narrower than a reminder's. This configures
 * the **linked reminder's** recurrence, not the due's: the prototype calls it `remRepeat` and
 * `syncDueRem` passes it straight through to the reminder it creates ([LOG-09]).
 */
export const dueReminderRepeatSchema = z.enum(['none', 'weekly', 'monthly']);
export type DueReminderRepeat = z.infer<typeof dueReminderRepeatSchema>;

export const dueSchema = z
  .object({
    id: objectId,
    accountId: objectId,
    direction: dueDirectionSchema,
    personName: z.string().min(1).max(80),
    /** Resolved directory contact, when the person matches a known account contact ([LOG-12]). */
    personContactId: objectId.optional(),
    amount: moneyAmount,
    /** When the money was lent or borrowed — [LOG-01]'s `on`. */
    on: dateOnlyString,
    /**
     * Expected return date — [LOG-01]'s `back`. **Nullable, and distinct from `on`.**
     *
     * [LOG-09] branches on it: with no return date there is nothing to remind about, so saving
     * without one deletes any linked reminder and none may be created. Collapsing this into a
     * single date makes that rule unrepresentable.
     */
    back: dateOnlyString.nullable(),
    notes: z.string().max(200).optional(),
    status: dueStatusSchema,
    /** Set on settle ([SCR-09]); cleared on reopen. */
    settledOn: dateOnlyString.nullable(),
    /** The recurrence handed to the linked reminder when one exists. */
    reminderRepeat: dueReminderRepeatSchema,
    /**
     * The reminder this due owns ([LOG-09]), paired with `Reminder.dueId`. Cleared on settle and on
     * delete. Never leave one side set without the other.
     */
    reminderId: objectId.nullable(),
  })
  .merge(timestampsSchema);
export type Due = z.infer<typeof dueSchema>;

/**
 * `remindMe` is the editor's toggle ([OVL-10]), not stored state — the server resolves it against
 * `back` and owns `reminderId`. A reminder is created only when `remindMe` is on **and** `back` is
 * set ([LOG-09]).
 */
export const createDueInputSchema = dueSchema
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    status: true,
    settledOn: true,
    reminderId: true,
  })
  .extend({ remindMe: z.boolean().default(false) });
export type CreateDueInput = z.infer<typeof createDueInputSchema>;

/**
 * **A clearable field is `.nullable()`, not merely optional — this is the `Entry` bug, forestalled.**
 *
 * Under `.partial()` merge semantics *"the user cleared this"* and *"the client did not mention
 * this"* arrive as the same request, so an optional field can never be emptied. `[OVL-08]` hit that
 * for real: its editor submits every field, a cleared remark was indistinguishable from an unmentioned
 * one, and the fix was to make editing a whole-body replacement (`PUT`).
 *
 * `[OVL-10]`'s editor is the same shape — a full-screen form with every field visible — so it would
 * have hit it too, on `notes` and `personContactId`. Rather than a second replacement route, the clearable fields are
 * nullable here: **absent means leave it, `null` means clear it, a value means set it.** That is the
 * idiom `back` already uses two fields up in `dueBaseSchema`, for exactly this reason.
 *
 * Whoever builds the route must therefore `$unset` on an explicit `null` rather than `$set` it.
 * Neither the route nor the screen exists yet — this is the contract getting the shape right before
 * either does. `DECISIONS.md` records the audit that found it.
 */
/** `accountId` is omitted — a due does not move between accounts. */
export const updateDueInputSchema = createDueInputSchema
  .omit({ accountId: true })
  .partial()
  .extend({
    notes: z.string().max(200).nullable().optional(),
    /** Cleared when a resolved contact is unlinked and the due keeps only its typed `personName`. */
    personContactId: objectId.nullable().optional(),
  });
export type UpdateDueInput = z.infer<typeof updateDueInputSchema>;
