// Pure module: no React, no DOM API, no `?url` assets. The Workers-runtime parity test loads it.
// Shared by server.ts, queue.ts and parse.ts so the route modules do not import each other.

export const DEMO_REFUSAL = 'Not available in the demo. Nothing is saved.';
export const DEMO_SAMPLE_ONLY = 'The demo only accepts the sample statements. Your file was not uploaded.';

// JSON.stringify serializes at once, so every read hands out a copy and callers cannot mutate the store.
// Static Response.json is skipped because older Safari lacks it.
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Mirrors Hono's HTTPException: `worker/index.ts` onError renders it as `{ error: message }` with its status. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) { super(message); }
}
