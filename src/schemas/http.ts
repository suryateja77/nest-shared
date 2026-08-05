import { z } from 'zod';

/**
 * HTTP contract primitives — the envelope, the error shape and pagination.
 *
 * Both sides depend on these: `nest-data-service` declares them as Fastify response schemas, and
 * `nest-ui` branches on them. Changing anything here is a breaking change for both.
 *
 * **The envelope rule:** a single resource is returned bare; every list is an object with `items`.
 * One rule, and it means adding pagination to a list that did not have it is not a breaking change.
 */

/**
 * Stable, machine-readable error codes.
 *
 * The client branches on `code`, never on `message` — copy changes, and a UI that string-matches
 * prose breaks silently when it does.
 */
export const errorCodeSchema = z.enum([
  /** No session, or an expired one. The client should re-authenticate. */
  'UNAUTHENTICATED',
  /**
   * Authenticated, but the caller's role lacks the capability for this operation.
   *
   * Note this is **not** returned for a resource in an account the caller is not a member of —
   * that is `NOT_FOUND`, so the API never confirms the resource exists. See the `nest-authz` skill.
   */
  'FORBIDDEN',
  'NOT_FOUND',
  /** Request failed schema validation; `details` carries the offending fields. */
  'VALIDATION_FAILED',
  /** The write conflicts with current state — a concurrent edit, or a duplicate. */
  'CONFLICT',
  'RATE_LIMITED',
  /** Unexpected server fault. `message` is generic by contract; nothing internal leaks. */
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * One field-level validation failure, shaped so `react-hook-form` can attach it to an input.
 * `path` mirrors zod's issue paths — `['amount']`, or `['customValues', '<fieldId>']`.
 */
export const fieldIssueSchema = z.object({
  path: z.array(z.string()),
  message: z.string(),
});
export type FieldIssue = z.infer<typeof fieldIssueSchema>;

/**
 * The error body for every non-2xx response.
 *
 * `message` is **user-safe by contract**: no stack, no driver text, no internal identifiers. The
 * server maps its internal errors to this shape in one place.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(fieldIssueSchema).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Opaque forward cursor. The client stores and returns it verbatim and must not parse it — the
 * encoding is a server concern and is free to change.
 */
export const cursorSchema = z.string().min(1);

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Query parameters for any paginated list.
 *
 * Cursor rather than offset: entries are inserted while the ledger is being scrolled, and offset
 * paging duplicates or skips rows whenever that happens.
 */
export const paginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Wraps an item schema into the list envelope.
 *
 * `nextCursor` is `null` on the last page — explicitly null rather than absent, so an exhausted
 * list and a malformed response are distinguishable.
 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}

/** `{ items, nextCursor }` for a given item type. */
export type Paginated<T> = { items: T[]; nextCursor: string | null };
