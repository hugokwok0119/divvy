import type { GroupSummary } from '../types';

/** The stored group when the account still has it, else the only group, else null (ask). */
export function pickGroup(stored: string | null, groups: GroupSummary[]): string | null {
  if (stored && groups.some((g) => g.id === stored)) return stored;
  return groups.length === 1 ? groups[0].id : null;
}
