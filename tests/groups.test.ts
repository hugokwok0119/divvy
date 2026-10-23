import { describe, expect, it } from 'vitest';
import { pendingSectionIds, pickGroup } from '../src/lib/groups';
import type { GroupSummary } from '../src/types';

const group = (id: string): GroupSummary => ({ id, name: id, role: 'owner', memberId: `m_${id}`, peopleCount: 1, pendingCount: 0 });
const h1 = group('h1');
const h2 = group('h2');

describe('pickGroup', () => {
  it('keeps a stored group the account still has', () => {
    expect(pickGroup('h2', [h1, h2])).toBe('h2');
  });

  it('falls back to the only group', () => {
    expect(pickGroup('gone', [h1])).toBe('h1');
  });

  it('asks when the stored group is gone and there are several', () => {
    expect(pickGroup('gone', [h1, h2])).toBeNull();
  });

  it('asks when nothing is stored and there are several', () => {
    expect(pickGroup(null, [h1, h2])).toBeNull();
  });
});

describe('pendingSectionIds', () => {
  const withPending = (id: string, pendingCount: number): GroupSummary => ({ ...group(id), pendingCount });

  it('lists the current group first, then others with Pending rows', () => {
    const groups = [withPending('h1', 0), withPending('h2', 3), withPending('h3', 0), withPending('h4', 1)];
    expect(pendingSectionIds(groups, 'h1')).toEqual(['h1', 'h2', 'h4']);
  });

  it('lists the current group even when it has no Pending rows', () => {
    const groups = [withPending('h1', 2), withPending('h2', 0)];
    expect(pendingSectionIds(groups, 'h2')).toEqual(['h2', 'h1']);
  });
});
