import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })));

describe('api client', () => {
  it('returns the parsed body on success', async () => {
    stub(200, { me: { memberId: 'm1', role: 'owner' } });
    expect((await api.bootstrap()).me.memberId).toBe('m1');
  });

  it('reads legacy subscription labels through the compatibility layer', async () => {
    stub(200, {
      me: { memberId: 'm1', role: 'owner' },
      household: {
        id: 'h1', name: 'Ours', currencyCode: 'CAD', timezone: 'America/Vancouver',
        customCategories: ['Software & Subscriptions', 'Pets'],
      },
      members: [], cards: [], cycles: [],
      transactions: [{ category: 'Software & Subscriptions' }],
      queue: [{ category: 'Software & Subscriptions' }],
      categoryPreferences: { adobe: 'Software & Subscriptions' },
    });

    const data = await api.bootstrap();
    expect(data.transactions[0].category).toBe('Subscriptions');
    expect(data.queue[0].category).toBe('Subscriptions');
    expect(data.categoryPreferences.adobe).toBe('Subscriptions');
    expect(data.household.customCategories).toEqual(['Pets']);
  });

  it('throws ApiError 401 when signed out', async () => {
    stub(401, { error: 'Not signed in' });
    await expect(api.bootstrap()).rejects.toBeInstanceOf(ApiError);
    await expect(api.bootstrap()).rejects.toMatchObject({ status: 401 });
  });

  it('surfaces the server error message', async () => {
    stub(409, { error: 'Cycle is already settled' });
    await expect(api.settleCycle('cy1')).rejects.toThrow('Cycle is already settled');
  });

  it('resolves to undefined on 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.deleteTransaction('t1', 1)).resolves.toBeUndefined();
  });

  it('posts a bulk queue import to /api/queue/bulk and returns the summary', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/queue/bulk');
      expect(JSON.parse(init!.body as string)).toEqual({ items: [{ id: 'q1' }] });
      return new Response(JSON.stringify({
        created: [{ id: 'q1' }],
        summary: { inserted: 1, duplicate: 0, rejected: 0 },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.createQueueItems([{ id: 'q1' }]);
    expect(result.summary).toEqual({ inserted: 1, duplicate: 0, rejected: 0 });
    expect(result.created).toHaveLength(1);
  });

  it('surfaces structured field errors from a rejected bulk import', async () => {
    stub(400, { error: 'Invalid queue import', fields: { 'items[0].date': 'Expected YYYY-MM-DD' } });
    await expect(api.createQueueItems([{ id: 'q1' }])).rejects.toThrow('Invalid queue import');
  });

  it('posts selected review ids to the bulk-delete endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/queue/delete-bulk');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init!.body as string)).toEqual({ ids: ['q2', 'q1'], revisions: { q2: 1, q1: 1 } });
      return new Response(JSON.stringify({ deletedIds: ['q2', 'q1'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.deleteQueueItems(['q2', 'q1'], { q2: 1, q1: 1 })).resolves.toEqual(['q2', 'q1']);
  });
});


it('posts explicit closure confirmation and exact selected versions', async () => {
  const input = { cycleId: 'cy1', transactionIds: ['t1'], confirmed: true as const, revisions: { t1: 7 } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/cycles/close');
    expect(JSON.parse(init!.body as string)).toEqual(input);
    return new Response(JSON.stringify({ id: 'cy1', closedByName: 'Alex' }), { status: 201 });
  }));
  expect(await api.closeCycle(input)).toMatchObject({ id: 'cy1', closedByName: 'Alex' });
});

it('posts an atomic Pending breakdown with stable child identity and revision', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/queue/q%20%2F%3F/split');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ queueItemId: 'q-child', amountCents: -3000, revision: 7 });
    return new Response(JSON.stringify({ original: { id: 'q /?' }, separated: { id: 'q-child' } }), { status: 200 });
  }));
  expect(await (api as any).splitQueueItem('q /?', 'q-child', -3000, 7)).toMatchObject({ separated: { id: 'q-child' } });
});
