// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
// Replays a recorded `POST /api/ai/parse-receipt` answer for the 13 sample PDFs; Gemini is never called.
import { findExplicitCategoryPreference } from '../lib/category';
import { DEMO_SAMPLE_ONLY, json } from './http';
import type { DemoState, SampleResult } from './types';

type Row = { date: string | null; store: string | null; amountCents: number | null; category: string | null };

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves after `ms`, or rejects like fetch does when `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  const aborted = () => new DOMException('Aborted', 'AbortError');
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function parseHandler(state: DemoState, samples: SampleResult[], parseDelayMs: number) {
  return async ({ request }: { request: Request }) => {
    await delay(parseDelayMs, request.signal);
    // Match on the bytes only: file name and content type are visitor-controlled.
    const hash = await sha256Hex(await request.arrayBuffer());
    const sample = samples.find((s) => s.sha256 === hash);
    if (!sample) return json({ error: DEMO_SAMPLE_ONLY, reason: 'demo_sample_only' }, 403);
    if (sample.status !== 200) return json(sample.body, sample.status);
    // worker/routes/ai.ts:81-92 and 117-120: exact saved relabels win, then row 0 is copied to the top level.
    const body = structuredClone(sample.body) as Row & { transactions: Row[] };
    const preferences = state.bootstrap.categoryPreferences;
    for (const row of body.transactions) {
      if (row.store) row.category = findExplicitCategoryPreference(row.store, preferences) ?? row.category;
    }
    const first = body.transactions[0] ?? { date: null, store: null, amountCents: null, category: null };
    return json({ ...body, date: first.date, store: first.store, amountCents: first.amountCents, category: first.category });
  };
}
