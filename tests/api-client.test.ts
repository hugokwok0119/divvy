import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { api, apiFor, ApiError, setCurrentGroup } from '../src/lib/api';

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

describe('group-aware api client', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const captureFetch = () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ me: { memberId: 'm1', role: 'owner' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return () => fetchMock.mock.calls.at(-1)![1]!.headers as Record<string, string>;
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', fakeStorage);
  });
  afterEach(() => setCurrentGroup(null));

  it('sends the current group on every request', async () => {
    const headers = captureFetch();
    setCurrentGroup('h2');
    await api.bootstrap();
    expect(headers()['x-divvy-group']).toBe('h2');
    expect(store.get('divvy.groupId')).toBe('h2');
  });

  it('sends a fixed group through apiFor', async () => {
    const headers = captureFetch();
    setCurrentGroup('h2');
    await apiFor('h3').bootstrap();
    expect(headers()['x-divvy-group']).toBe('h3');
  });

  it('sends no group header before one is chosen', async () => {
    const headers = captureFetch();
    setCurrentGroup(null);
    await api.bootstrap();
    expect(headers()).not.toHaveProperty('x-divvy-group');
    expect(store.has('divvy.groupId')).toBe(false);
  });

  it('puts the group in the export link', () => {
    setCurrentGroup('h2');
    expect(api.exportUrl()).toBe('/api/export?group=h2');
    setCurrentGroup(null);
    expect(api.exportUrl()).toBe('/api/export');
  });

  it('keeps its group when localStorage changes', async () => {
    const headers = captureFetch();
    setCurrentGroup('h2');
    localStorage.setItem('divvy.groupId', 'h9');
    await api.bootstrap();
    expect(headers()['x-divvy-group']).toBe('h2');
  });

  it('surfaces group_required as the ApiError reason', async () => {
    stub(400, { error: 'Choose a group', reason: 'group_required' });
    await expect(api.bootstrap()).rejects.toMatchObject({
      status: 400, message: 'Choose a group', reason: 'group_required',
    });
  });

  it('sends the group with a receipt scan', async () => {
    const headers = captureFetch();
    setCurrentGroup('h2');
    await api.parseReceipt(new File(['x'], 'r.png'));
    expect(headers()['x-divvy-group']).toBe('h2');
  });

  it('lists and creates groups', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/groups');
      return init?.method === 'POST'
        ? new Response(JSON.stringify({ id: 'h4', name: 'Trip' }), { status: 201 })
        : new Response(JSON.stringify({ groups: [], canCreate: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.groups()).toEqual({ groups: [], canCreate: true });
    const input = { name: 'Trip', currencyCode: 'CAD', timezone: 'America/Vancouver' };
    expect(await api.createGroup(input)).toMatchObject({ id: 'h4' });
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual(input);
  });
});
