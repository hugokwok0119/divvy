import { describe, expect, it } from 'vitest';
import { buildSeedSql, resolveTarget, signSessionCookie } from '../scripts/seed-demo/build';

describe('demo seed', () => {
  it('refuses any target but local or staging', () => {
    expect(() => resolveTarget('production')).toThrow('seed target must be local or staging');
    expect(() => resolveTarget('divvy')).toThrow();
  });

  it('signSessionCookie rejects an empty secret', async () => {
    await expect(signSessionCookie('tok', '', 'http://localhost:8787')).rejects.toThrow();
  });

  it('uses the __Secure- prefix only for https', async () => {
    expect((await signSessionCookie('tok', 's', 'https://divvy-staging.hugohhkwok.workers.dev')).name).toMatch(/^__Secure-/);
    expect((await signSessionCookie('tok', 's', 'http://localhost:8787')).name).not.toMatch(/^__Secure-/);
  });

  it('is deterministic and one statement per line', () => {
    const a = buildSeedSql({ now: 1_800_000_000_000, sessionToken: 't' });
    expect(a).toBe(buildSeedSql({ now: 1_800_000_000_000, sessionToken: 't' }));
    expect(a.trim().split('\n').every((l) => l.trim().endsWith(';'))).toBe(true);
  });
});
