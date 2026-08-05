import { z } from 'zod';
import {
  isoDateString,
  localDateTimeString,
  moneyAmount,
  objectId,
  timestampsSchema,
} from './common.js';

/** [LOG-01] / [OVL-11]. `quarterly` is load-bearing — [REQ-6] names maintenance as the quarterly case. */
export const reminderRepeatSchema = z.enum([
  'none',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
]);
export type ReminderRepeat = z.infer<typeof reminderRepeatSchema>;

/**
 * How far ahead of `due` the notification fires ([OVL-11]).
 *
 * Wire keys, not the design's display strings ('At time', '1 day before'…) — those are labels and
 * become a localisation problem at [GAP-9]. `notify` shifts *delivery* only: never mutate `due` to
 * implement "1 day before".
 */
export const notifyBeforeSchema = z.enum(['at-time', '1-hour', '1-day', '2-days']);
export type NotifyBefore = z.infer<typeof notifyBeforeSchema>;

/** [LOG-01]. `snoozed` is a real status with its own filter chip on [SCR-10], not a derived view. */
export const reminderStatusSchema = z.enum(['upcoming', 'snoozed', 'done']);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

/**
 * One completion of a reminder ([LOG-08]). A repeating reminder rolls forward on done and appends a
 * log; `remUndo(remId, logId)` restores `due` from that log's `dueWas`. Each log is individually
 * undoable or removable, so this is a list, not a single last-value.
 */
export const reminderLogSchema = z.object({
  id: objectId,
  /** When it was marked done — a true instant. */
  at: isoDateString,
  /** The `due` the reminder held before rolling forward. Restored by undo. */
  dueWas: localDateTimeString,
});
export type ReminderLog = z.infer<typeof reminderLogSchema>;

export const reminderSchema = z
  .object({
    id: objectId,
    accountId: objectId,
    title: z.string().min(1).max(80),
    /**
     * Wall-clock due date and time, `YYYY-MM-DDTHH:mm` ([LOG-01]). One field, not a date/time pair:
     * `bumpDue` advances it, overdue is `status !== 'done' && due < now`, and `snoozeTill` and
     * `dueWas` share the shape — splitting it forces recombination at every comparison.
     */
    due: localDateTimeString,
    /** Optional amount shown on the row ([SCR-10]). `null` when the reminder is not about money. */
    amount: moneyAmount.nullable(),
    /** The book this reminder relates to, for the row's tint ([SCR-10]). `null` when unset. */
    bookId: objectId.nullable(),
    repeat: reminderRepeatSchema,
    notifyBefore: notifyBeforeSchema,
    notes: z.string().max(200).optional(),
    status: reminderStatusSchema,
    /** Set with `status: 'snoozed'` ([LOG-08]). Effective fire time is `snoozeTill ?? due − notify`. */
    snoozeTill: localDateTimeString.nullable(),
    logs: z.array(reminderLogSchema),
    /**
     * Back-reference to the `Due` that owns this reminder ([LOG-09]). Present only for
     * due-generated reminders, and paired with `Due.reminderId` — one side without the other is the
     * orphan the spec forbids.
     */
    dueId: objectId.nullable(),
  })
  .merge(timestampsSchema);
export type Reminder = z.infer<typeof reminderSchema>;

/**
 * `status`, `snoozeTill`, `logs` and `dueId` are server-owned: status moves through the done and
 * snooze routes, and `dueId` is set only by the dues sync ([LOG-09]) — a client must not be able to
 * link a reminder to an arbitrary due.
 */
export const createReminderInputSchema = reminderSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  snoozeTill: true,
  logs: true,
  dueId: true,
});
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>;

/** `accountId` is omitted — a reminder does not move between accounts. */
export const updateReminderInputSchema = createReminderInputSchema
  .omit({ accountId: true })
  .partial();
export type UpdateReminderInput = z.infer<typeof updateReminderInputSchema>;

/** [OVL-12] — the snooze sheet's four options. The toast reports the resolved time ([LOG-08]). */
export const snoozePresetSchema = z.enum([
  '10-minutes',
  '1-hour',
  'this-evening',
  'tomorrow-morning',
]);
export type SnoozePreset = z.infer<typeof snoozePresetSchema>;

/** Snooze by a preset, or to an explicit wall-clock time. */
export const snoozeReminderInputSchema = z.union([
  z.object({ preset: snoozePresetSchema }),
  z.object({ until: localDateTimeString }),
]);
export type SnoozeReminderInput = z.infer<typeof snoozeReminderInputSchema>;
