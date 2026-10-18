/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sampleResults from '../src/demo/sample-results.json';
import { buildDemoData } from '../src/demo/data';
import { createDemoServer, DEMO_SAMPLE_ONLY, type DemoServerOptions } from '../src/demo/server';
import type { SampleResult } from '../src/demo/types';
import type { QueueItem } from '../src/types';

const samples = sampleResults.samples as SampleResult[];
const pdf = (fileName: string) => readFileSync(new URL(`../scripts/statement-eval/mock-statements/${fileName}`, import.meta.url));
const setup = (options: DemoServerOptions = {}) => {
  const state = buildDemoData(samples);
  return { state, server: createDemoServer(state, samples, { parseDelayMs: 0, ...options }) };
};
type Server = ReturnType<typeof setup>['server'];
const parse = (server: Server, body: BodyInit, signal?: AbortSignal) =>
  server.handle(new Request('https://demo.test/api/ai/parse-receipt', { method: 'POST', body, signal }));
const randomBytes = () => crypto.getRandomValues(new Uint8Array(4096));
const SAMPLE_ONLY = { error: DEMO_SAMPLE_ONLY, reason: 'demo_sample_only' };
type Row = { date: string; store: string; amountCents: number; category: string };

describe('demo statement replay', () => {
  it('replays every reconciled sample', async () => {
    const { server } = setup();
    const reconciled = samples.filter((s) => s.status === 200);
    expect(reconciled).toHaveLength(9);
    for (const sample of reconciled) {
      const res = await parse(server, pdf(sample.fileName));
      expect(res.status, sample.id).toBe(200);
      expect(await res.json(), sample.id).toEqual(sample.body);
    }
  });

  it('refuses every no-total sample like production', async () => {
    const { server } = setup();
    for (const id of ['sample-d1', 'sample-d2', 'sample-e1', 'sample-e2']) {
      const sample = samples.find((s) => s.id === id)!;
      const res = await parse(server, pdf(sample.fileName));
      expect(res.status, id).toBe(422);
      const body = await res.json();
      expect(body, id).toEqual(sample.body);
      expect(body, id).toMatchObject({ reason: 'reconciliation_failed', statementTotalCents: null });
    }
  });

  it('refuses any other bytes', async () => {
    const { state, server } = setup();
    const queued = state.bootstrap.queue.length;
    const flipped = new Uint8Array(pdf('sample-a1.pdf'));
    flipped[flipped.length >> 1] ^= 0xff;
    for (const body of [randomBytes(), flipped, new Uint8Array(0)]) {
      const res = await parse(server, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(SAMPLE_ONLY);
    }
    expect(state.bootstrap.queue).toHaveLength(queued);
  });

  it('ignores the file name', async () => {
    const { server } = setup();
    const res = await parse(server, new File([randomBytes()], 'sample-a1.pdf', { type: 'application/pdf' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(SAMPLE_ONLY);
  });

  it('applies saved category preferences', async () => {
    const { server } = setup();
    const sample = samples.find((s) => s.id === 'sample-c1')!;
    const recorded = structuredClone(sample.body);
    const rows = (sample.body as { transactions: Row[] }).transactions;
    const store = rows[0].store;
    expect(rows[0].category).not.toBe('Dining');
    const send = (method: string, path: string, body: unknown) => server.handle(new Request(`https://demo.test${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const imported = await (await send('POST', '/api/queue/bulk', { items: [{ id: 'pref_0', date: rows[0].date, store,
      amountCents: rows[0].amountCents, category: rows[0].category, payerId: 'mem_alex', cardId: 'card_demo_visa',
      splitType: null, splitRule: null, source: 'image' }] })).json() as { created: QueueItem[] };
    const patched = await send('PATCH', '/api/queue/pref_0', { revision: imported.created[0].revision, category: 'Dining' });
    expect(patched.status).toBe(200);

    const res = await parse(server, pdf(sample.fileName));
    expect(res.status).toBe(200);
    const body = await res.json() as Row & { transactions: Row[] };
    expect(body.transactions.map((row) => row.category))
      .toEqual(rows.map((row) => row.store === store ? 'Dining' : row.category));
    expect(body).toMatchObject({ date: rows[0].date, store, amountCents: rows[0].amountCents, category: 'Dining' });
    expect(sample.body).toEqual(recorded);
  });

  it('honors abort', async () => {
    const { state, server } = setup({ parseDelayMs: 50 });
    const queued = state.bootstrap.queue.length;
    const controller = new AbortController();
    const pending = parse(server, pdf('sample-a1.pdf'), controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await expect(parse(server, pdf('sample-a1.pdf'), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.bootstrap.queue).toHaveLength(queued);
  });

  it('waits the parse delay before answering', async () => {
    const { server } = setup({ parseDelayMs: 40 });
    const started = Date.now();
    expect((await parse(server, pdf('sample-a1.pdf'))).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});
