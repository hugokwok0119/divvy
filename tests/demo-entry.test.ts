import { beforeAll, describe, expect, it, vi } from 'vitest';
import { isDemoMode } from '../src/lib/demo-mode';

// The node project has no DOM: stub the components (the card pulls in the `?url` PDF imports).
vi.mock('../src/demo/DemoBanner', () => ({ DemoBanner: () => null }));
vi.mock('../src/demo/HowItWorksCard', () => ({ HowItWorksCard: () => null }));
// Lets one test make the first install() throw partway through.
const failNext = vi.hoisted(() => ({ value: false }));
vi.mock('../src/demo/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/demo/data')>();
  return {
    ...actual,
    buildDemoData: (...args: Parameters<typeof actual.buildDemoData>) => {
      if (failNext.value) { failNext.value = false; throw new Error('boom'); }
      return actual.buildDemoData(...args);
    },
  };
});

const original = vi.fn(async () => new Response('network'));
const assign = vi.fn();
let demo: typeof import('../src/demo');

beforeAll(async () => {
  vi.stubGlobal('location', { origin: 'https://divvy.test', assign });
  vi.stubGlobal('fetch', original);
  demo = await import('../src/demo');
});

describe('demo entry', () => {
  it('a failed install stays out of demo mode and can be retried', async () => {
    failNext.value = true;
    expect(() => demo.install()).toThrow('boom');
    expect(globalThis.fetch).toBe(original);
    expect(isDemoMode()).toBe(false);
    demo.install();
    const res = await fetch('/api/bootstrap');
    expect((await res.json() as { household: { name: string } }).household.name).toBe('Demo Household');
    expect(original).not.toHaveBeenCalled();
  });

  it('install routes /api to the demo', async () => {
    demo.install();
    const res = await fetch('/api/bootstrap');
    const body = await res.json() as { household: { name: string } };
    expect(body.household.name).toBe('Demo Household');
    expect(original).not.toHaveBeenCalled();
    expect(isDemoMode()).toBe(true);
  });

  it('install twice is a no-op', async () => {
    const guarded = globalThis.fetch;
    demo.install();
    expect(globalThis.fetch).toBe(guarded);
    await fetch('/api/bootstrap');
    expect(original).not.toHaveBeenCalled();
  });

  it('exitDemo reloads to root', () => {
    demo.exitDemo();
    expect(assign).toHaveBeenCalledWith('/');
  });
});
