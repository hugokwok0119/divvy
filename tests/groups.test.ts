import { describe, expect, it } from 'vitest';
import { pickGroup } from '../src/lib/groups';
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
