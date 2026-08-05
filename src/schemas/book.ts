import { z } from 'zod';
import { objectId, signedMoneyAmount, timestampsSchema } from './common.js';

/**
 * [LOG-01]: `CustomField { name, type: 'text'|'toggle', placeholder? }`. [OVL-08] renders each as
 * "text input or switch", and [SCR-07]'s custom-field builder offers exactly those two.
 */
export const customFieldTypeSchema = z.enum(['text', 'toggle']);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const customFieldSchema = z.object({
  /** Stable id: entry values key off this, so renaming a field must not orphan them. */
  id: objectId,
  name: z.string().min(1).max(40),
  type: customFieldTypeSchema,
  placeholder: z.string().max(60).optional(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

const isUnique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/**
 * Categories and payment modes are grouping keys, not just labels: [LOG-05] aggregates cash-out
 * `byCat` and `byMode` for Insights. A duplicate would silently split one total into two rows, and
 * [SCR-07] lets these be renamed and reordered freely, so uniqueness is enforced here rather than
 * left to the editor.
 */
const uniqueLabels = z.array(z.string().min(1).max(40)).refine(isUnique, 'Entries must be unique');

export const bookSchema = z
  .object({
    id: objectId,
    accountId: objectId,
    name: z.string().min(1).max(60),
    /** The book's subtitle, shown as row meta on [SCR-05] — e.g. "Runs since Jan 2026". */
    sub: z.string().max(80).optional(),
    /** Tint used for the book's list-row rail and derived member/book colour hashing ([DS-1]). */
    tint: z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a 6-digit hex color'),
    /** Opening balance. Signed — a book may legitimately start in the red. */
    opening: signedMoneyAmount,
    categories: uniqueLabels,
    paymentModes: uniqueLabels,
    /** Ids must be unique — an entry's `customValues` keys off them. */
    customFields: z
      .array(customFieldSchema)
      .refine((fields) => isUnique(fields.map((field) => field.id)), 'Field ids must be unique'),
    /**
     * Entry-field toggles from [SCR-07]. [OVL-08] reads these to decide which sections of the entry
     * sheet render at all, so an entry may carry no category or payment mode by design.
     */
    useCategory: z.boolean(),
    useMode: z.boolean(),
    useAttach: z.boolean(),
  })
  .merge(timestampsSchema);
export type Book = z.infer<typeof bookSchema>;

export const createBookInputSchema = bookSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateBookInput = z.infer<typeof createBookInputSchema>;

/**
 * `accountId` is omitted: moving a book between accounts ([REQ-4]) is a separate operation that
 * needs `bookSettings` on **both** the source and the destination account, so it must not be
 * reachable through a general update.
 */
export const updateBookInputSchema = createBookInputSchema.omit({ accountId: true }).partial();
export type UpdateBookInput = z.infer<typeof updateBookInputSchema>;
