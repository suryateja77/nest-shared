import { z } from 'zod';

/**
 * Every role a member can hold — the four chips [SCR-08] renders, and the four an invite may carry.
 *
 * **Ownership is not a role.** The revised [LOG-01] models the account creator as
 * `Account.createdBy`, and the handoff glossary is explicit: *"owner = the member who created the
 * account (`account.createdBy`), not a role in `CAPS`"*. An earlier version of this file carried a
 * fifth `OWNER` role with fixed capabilities outside the editable matrix; that was the same
 * invariant expressed less directly, and it disagreed with [LOG-01]'s `Member.role`.
 *
 * `createdBy` is the stronger floor of administrability, which is why the swap is safe: a role can
 * be edited, reassigned or invited into, whereas `createdBy` is set once at creation ([LOG-15]),
 * never changes, and is not addressable by any matrix. [LOG-16] gates every account-administration
 * action on it — an ADMIN who did not create the account gets [SCR-08]'s read-only variant.
 *
 * Because every role is now assignable, there is exactly one role enum. The `assignableRoleSchema`
 * this file used to also export was the same four values and is gone rather than kept as an alias:
 * two names for one set is how the two drift apart.
 */
export const roleSchema = z.enum(['ADMIN', 'EDITOR', 'VIEWER', 'TEEN']);
export type Role = z.infer<typeof roleSchema>;

/** The six per-role capabilities from [LOG-01]'s role/capability matrix. */
export const permissionsSchema = z.object({
  viewEntries: z.boolean(),
  addEntries: z.boolean(),
  editAnyEntry: z.boolean(),
  deleteEntries: z.boolean(),
  manageMembers: z.boolean(),
  bookSettings: z.boolean(),
});
export type Permissions = z.infer<typeof permissionsSchema>;
export type Capability = keyof Permissions;

/**
 * The fixed capability order from [LOG-01] — `['View entries','Add entries','Edit any entry',
 * 'Delete entries','Manage members','Book settings']`. [SCR-08] renders the permission rows in this
 * order, so it is part of the contract rather than a UI detail.
 *
 * [LOG-01] models `Perms` as `boolean[6]`, keyed positionally. Stored here as a named object
 * instead — the same six flags in the same order, but a reordering cannot silently reassign them.
 */
export const CAPABILITY_ORDER = [
  'viewEntries',
  'addEntries',
  'editAnyEntry',
  'deleteEntries',
  'manageMembers',
  'bookSettings',
] as const satisfies readonly Capability[];

/** Human labels for the capability rows on [SCR-08], in `CAPABILITY_ORDER`. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  viewEntries: 'View entries',
  addEntries: 'Add entries',
  editAnyEntry: 'Edit any entry',
  deleteEntries: 'Delete entries',
  manageMembers: 'Manage members',
  bookSettings: 'Book settings',
};

/**
 * `Perms` from [LOG-01] — the per-account capability matrix. The account creator edits it on
 * [SCR-08], so it is stored per account and must be resolved per request. Never hard-code
 * role → capability at a call site, and never read it from a JWT: roles change while a token is live.
 *
 * Keyed by `roleSchema`, so the matrix holds exactly the four chips [SCR-08] renders — which is now
 * every role there is. No role sits outside it: the creator's authority comes from
 * `Account.createdBy` ([LOG-16]), not from a row this matrix cannot reach.
 *
 * **The prototype keeps one global matrix** (`state.perms`), and [LOG-15] notes a new account
 * "inherits the same matrix". Stored per account here instead, because [LOG-16] describes the
 * edit as reaching "every book in this account" — an account-scoped blast radius, not a global one.
 * A global matrix would let one family's admin re-permission every other family's books.
 */
export const rolePermissionsSchema = z.record(roleSchema, permissionsSchema);
export type RolePermissions = z.infer<typeof rolePermissionsSchema>;

/** The seed matrix from [LOG-01]. The starting point for a new account, not a constant. */
export const ROLE_PERMISSION_SEED: Record<Role, Permissions> = {
  ADMIN: {
    viewEntries: true,
    addEntries: true,
    editAnyEntry: true,
    deleteEntries: true,
    manageMembers: true,
    bookSettings: true,
  },
  EDITOR: {
    viewEntries: true,
    addEntries: true,
    editAnyEntry: true,
    deleteEntries: false,
    manageMembers: false,
    bookSettings: false,
  },
  VIEWER: {
    viewEntries: true,
    addEntries: false,
    editAnyEntry: false,
    deleteEntries: false,
    manageMembers: false,
    bookSettings: false,
  },
  TEEN: {
    viewEntries: true,
    addEntries: true,
    editAnyEntry: false,
    deleteEntries: false,
    manageMembers: false,
    bookSettings: false,
  },
};
