import { z } from 'zod';

/**
 * Every role a member can hold.
 *
 * `OWNER` is the account creator, carrying the same six capabilities as `ADMIN`. The prototype
 * seeds the personal account's sole member as `OWNER` and styles it like an admin, but [LOG-01]'s
 * enum omits it — it is added here deliberately.
 */
export const roleSchema = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'TEEN']);
export type Role = z.infer<typeof roleSchema>;

/**
 * The four roles that can be **assigned** to someone — the chips on [SCR-08] and the roles an
 * invite may carry.
 *
 * `OWNER` is excluded on purpose. It belongs to whoever created the account and is not something a
 * member can be moved into: allowing it would make "invite as OWNER" a privilege-escalation path
 * into a role whose capabilities cannot be edited back down.
 */
export const assignableRoleSchema = z.enum(['ADMIN', 'EDITOR', 'VIEWER', 'TEEN']);
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

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
 * `Perms` from [LOG-01] — the per-account capability matrix. An admin edits it on [SCR-08], so it
 * is stored per account and must be resolved per request. Never hard-code role → capability at a
 * call site, and never read it from a JWT: roles change while a token is live.
 *
 * Keyed by `assignableRoleSchema`, so the matrix holds exactly the four chips [SCR-08] renders.
 * `OWNER` is absent by design — see `OWNER_PERMISSIONS`.
 */
export const rolePermissionsSchema = z.record(assignableRoleSchema, permissionsSchema);
export type RolePermissions = z.infer<typeof rolePermissionsSchema>;

/**
 * `OWNER`'s capabilities: the same six as the seeded `ADMIN`, and **fixed**.
 *
 * Kept out of the editable matrix so that an admin cannot strip the account creator's rights on
 * [SCR-08] — which would otherwise leave an account nobody can administer. Resolving a member's
 * capabilities therefore reads this constant for `OWNER` and the account's stored matrix for
 * everyone else.
 */
export const OWNER_PERMISSIONS: Permissions = {
  viewEntries: true,
  addEntries: true,
  editAnyEntry: true,
  deleteEntries: true,
  manageMembers: true,
  bookSettings: true,
};

/** The seed matrix from [LOG-01]. The starting point for a new account, not a constant. */
export const ROLE_PERMISSION_SEED: Record<AssignableRole, Permissions> = {
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
