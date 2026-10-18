// Data access only through scope.repo.
import { Hono } from 'hono';
import { requireScope } from '../lib/scope';
import {
  validateQueueInput, validateQueuePatch, validateQueueBulk, validateConfirmBody, validateTxInput,
  isPlainObject, expectedRevision, trimmedString, ID_MAX_LEN, MAX_BULK_BATCH, isFiniteIntCents,
} from '../lib/validate';
import type { Env } from '../index';

export const queueRoutes = new Hono<{ Bindings: Env }>();

queueRoutes.get('/', async (c) => {
  const { repo } = await requireScope(c);
  return c.json(await repo.queueItems());
});

queueRoutes.post('/', async (c) => {
  const { repo } = await requireScope(c);
  const { value, fields } = validateQueueInput(await c.req.json().catch(() => null), await repo.roster());
  if (!value) return c.json({ error: 'Invalid queue item', fields }, 400);
  return c.json(await repo.insertQueueItem(value), 201);
});

queueRoutes.post('/bulk', async (c) => {
  const { repo } = await requireScope(c);
  const { items, fields } = validateQueueBulk(await c.req.json().catch(() => null), await repo.roster());
  if (!items) return c.json({ error: 'Invalid queue import', fields }, 400);
  const result = await repo.insertQueueItemsBulk(items);
  return c.json({
    created: result.created,
    summary: { inserted: result.inserted, duplicate: result.duplicate, rejected: result.rejected },
  }, 201);
});

queueRoutes.post('/delete-bulk', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: 'Invalid queue deletion', fields: { ids: 'Expected a non-empty array' } }, 400);
  }
  if (body.ids.length > MAX_BULK_BATCH) {
    return c.json({
      error: 'Invalid queue deletion',
      fields: { ids: `At most ${MAX_BULK_BATCH} items` },
    }, 400);
  }
  const ids = body.ids.map((id) => trimmedString(id, ID_MAX_LEN));
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) {
    return c.json({
      error: 'Invalid queue deletion',
      fields: { ids: 'Expected unique non-empty ids' },
    }, 400);
  }
  if (!isPlainObject(body.revisions) || ids.some((id) => !expectedRevision((body.revisions as Record<string, unknown>)[id!]))) {
    return c.json({ error: 'Expected revisions for every selected expense' }, 400);
  }
  return c.json({ deletedIds: await repo.deleteQueueItems(ids as string[], body.revisions as Record<string, number>) });
});

queueRoutes.patch('/:id', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  const { value, fields } = validateQueuePatch(body, await repo.roster());
  if (!value) return c.json({ error: 'Invalid queue item', fields }, 400);
  return c.json(await repo.updateQueueItem(c.req.param('id'), value, body.revision));
});

queueRoutes.post('/:id/split', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision) || !isFiniteIntCents(body.amountCents)) {
    return c.json({ error: 'Expected expense revision and a valid amount to separate' }, 400);
  }
  const queueItemId = trimmedString(body.queueItemId, ID_MAX_LEN);
  if (!queueItemId) return c.json({ error: 'Expected a new Pending identity' }, 400);
  return c.json(await repo.splitQueueItem(c.req.param('id'), queueItemId, body.amountCents, body.revision));
});

queueRoutes.delete('/:id', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  await repo.deleteQueueItem(c.req.param('id'), body.revision);
  return c.body(null, 204);
});

queueRoutes.post('/:id/confirm', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  const { value, fields } = validateConfirmBody(body);
  if (!value) return c.json({ error: 'Invalid queue confirmation', fields }, 400);
  const roster = await repo.roster();
  const tx = validateTxInput(value.transaction, roster);
  if (!tx.value) return c.json({ error: 'Invalid transaction', fields: tx.fields }, 400);
  return c.json(
    await repo.confirmQueueItem(c.req.param('id'), value.transactionId, tx.value as never, body.revision),
    201,
  );
});
