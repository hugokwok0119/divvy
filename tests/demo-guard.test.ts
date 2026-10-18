import { describe, expect, it, vi } from 'vitest';
import { demoFetch } from '../src/demo/guard';
import { isDemoMode, setDemoMode } from '../src/lib/demo-mode';

const ORIGIN = 'https://divvy.test';

const setup = (handle: (request: Request) => Promise<Response> = async () => new Response('local')) => {
  const original = vi.fn(async () => new Response('network'));
  const seen: Request[] = [];
  const guarded = demoFetch(original as unknown as typeof fetch, ORIGIN, async (request) => {
    seen.push(request);
    return handle(request);
  });
  return { original, seen, guarded };
};

describe('demoFetch', () => {
  it('routes relative, absolute, URL and Request inputs to the handler', async () => {
    const inputs = [
      (init: RequestInit) => [`/api/bootstrap`, init] as const,
      (init: RequestInit) => [`${ORIGIN}/api/bootstrap`, init] as const,
      (init: RequestInit) => [new URL(`${ORIGIN}/api/bootstrap`), init] as const,
      (init: RequestInit) => [new Request(`${ORIGIN}/api/bootstrap`, init), undefined] as const,
    ];
    for (const make of inputs) {
      const { original, seen, guarded } = setup();
      const controller = new AbortController();
      const [input, init] = make({ method: 'POST', body: 'payload', headers: { 'x-test': '1' }, signal: controller.signal });
      const res = await guarded(input, init);
      expect(await res.text()).toBe('local');
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request.url).toBe(`${ORIGIN}/api/bootstrap`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-test')).toBe('1');
      expect(await request.text()).toBe('payload');
      expect(request.signal.aborted).toBe(false);
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      expect(original).not.toHaveBeenCalled();
    }
  });

  it('preserves a File body, as parseReceipt sends it', async () => {
    const { original, seen, guarded } = setup();
    const file = new File(['%PDF-sample'], 'statement.pdf', { type: 'application/pdf' });
    await guarded('/api/ai/parse-receipt', { method: 'POST', body: file });
    expect(seen[0].headers.get('content-type')).toBe('application/pdf');
    expect(await seen[0].text()).toBe('%PDF-sample');
    expect(original).not.toHaveBeenCalled();
  });

  it('merges init overrides into a Request input the way fetch does', async () => {
    const { seen, guarded } = setup();
    const base = new Request(`${ORIGIN}/api/transactions/1`, { method: 'POST', body: 'old', headers: { 'x-a': '1' } });
    await guarded(base, { method: 'PATCH', body: 'new', headers: { 'x-b': '2' } });
    expect(seen[0].method).toBe('PATCH');
    expect(await seen[0].text()).toBe('new');
    expect(seen[0].headers.get('x-b')).toBe('2');
    expect(seen[0].headers.get('x-a')).toBeNull();
  });

  it('never lets /api reach the network', async () => {
    const paths = ['/api', '/api/', '/API/bootstrap', '/Api', '/x/../api/bootstrap', '/x/%2e%2e/api/bootstrap', '/api/bootstrap?x=1#y', `${ORIGIN.toUpperCase()}/api/x`, '/%61pi/bootstrap', '/a%70i/bootstrap', '/%41PI/bootstrap'];
    for (const path of paths) {
      const { original, seen, guarded } = setup();
      await guarded(path);
      expect(seen, path).toHaveLength(1);
      expect(original, path).not.toHaveBeenCalled();
    }
    const { original, seen, guarded } = setup();
    await guarded('/apiary.png');
    expect(seen).toHaveLength(0);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('passes other paths and other origins to the original fetch', async () => {
    for (const path of ['/assets/x.js', 'https://example.com/api/x']) {
      const { original, seen, guarded } = setup();
      const init = { method: 'GET' };
      expect(await (await guarded(path, init)).text()).toBe('network');
      expect(original).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledWith(path, init);
      expect(seen).toHaveLength(0);
    }
  });

  it('turns handler exceptions into 500 without calling the network', async () => {
    const { original, guarded } = setup(async () => { throw new Error('boom'); });
    const res = await guarded('/api/bootstrap');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Demo error. Nothing was saved.' });
    expect(original).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when the handler aborts, without calling the network', async () => {
    const { original, guarded } = setup(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(guarded('/api/ai/parse-receipt', { method: 'POST', body: 'x' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(original).not.toHaveBeenCalled();
  });
});

describe('demo mode flag', () => {
  it('starts off and toggles in memory', () => {
    expect(isDemoMode()).toBe(false);
    setDemoMode(true);
    expect(isDemoMode()).toBe(true);
    setDemoMode(false);
    expect(isDemoMode()).toBe(false);
  });
});
