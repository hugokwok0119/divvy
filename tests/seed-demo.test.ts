import { describe, expect, it } from 'vitest';
import { buildSeedSql, resolveTarget, signSessionCookie } from '../scripts/seed-demo/build';

describe('demo seed', () => {
  it('refuses any target but local or staging', () => {
    expect(() => resolveTarget('production')).toThrow('seed target must be local or staging');
    expect(() => resolveTarget('divvy')).toThrow();
  });

  it('signSessionCookie rejects an empty secret', async () => {
    await expect(signSessionCookie('tok', '')).rejects.toThrow();
  });

  it('is deterministic and one statement per line', () => {
    const a = buildSeedSql({ now: 1_800_000_000_000, sessionToken: 't' });
    expect(a).toBe(buildSeedSql({ now: 1_800_000_000_000, sessionToken: 't' }));
    expect(a.trim().split('\n').every((l) => l.trim().endsWith(';'))).toBe(true);
  });
});
