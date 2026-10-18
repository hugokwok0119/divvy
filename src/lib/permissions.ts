export type Role = 'owner' | 'member';

export interface Permissions {
  canSettleCycle: boolean;
  canManageMembers: boolean;
  canManageCards: boolean;
  canManageCategories: boolean;
  canExportData: boolean;
}

/** Owner-only capabilities: settlement, member/card/category management, and
 * full-household export. Everything else (review, categorize, add shared
 * expenses) stays available to members and isn't gated here.
 *
 * This only decides what the UI shows. The server re-checks every one of these
 * through requireOwner(), so a crafted request still gets a 403. */
export function permissionsFor(role: Role): Permissions {
  const isOwner = role === 'owner';
  return {
    canSettleCycle: isOwner,
    canManageMembers: isOwner,
    canManageCards: isOwner,
    canManageCategories: isOwner,
    canExportData: isOwner,
  };
}
