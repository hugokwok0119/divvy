// Data access only through scope.repo.
import { Hono } from 'hono';
import { requireScope } from '../lib/scope';
import {
  validateTxInput, validateTxPatch, trimmedString, isPlainObject, MAX_BULK_BATCH,
  ID_MAX_LEN, CATEGORY_MAX_LEN, expectedRevision, isFiniteIntCents,
} from '../lib/validate';
import type { Env } from '../index';

export const transactionRoutes = new Hono<{ Bindings: Env }>();

transactionRoutes.get('/', async (c) => {
  const { repo } = await requireScope(c);
  const status = c.req.query('status') ?? 'active';
  const cycleId = c.req.query('cycleId');

  if (cycleId) return c.json(await repo.transactionsByCycle(cycleId));
  if (status === 'archived') return c.json(await repo.archivedTransactions());
  return c.json(await repo.activeTransactions());
});

transactionRoutes.get('/history/:expenseId', async (c) => {
  const { repo } = await requireScope(c);
  return c.json(await repo.expenseHistory(c.req.param('expenseId')));
});

transactionRoutes.post('/:id/split', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision) || !isFiniteIntCents(body.amountCents)) {
    return c.json({ error: 'Expected expense revision and a valid amount to separate' }, 400);
  }
  const transactionId = trimmedString(body.transactionId, ID_MAX_LEN);
  if (!transactionId) return c.json({ error: 'Expected a new transaction identity' }, 400);
  return c.json(await repo.splitTransaction(c.req.param('id'), transactionId, body.amountCents, body.revision));
});

transactionRoutes.post('/:id/pending', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) return c.json({ error: 'Review note must be at most 1000 characters' }, 400);
  return c.json(await repo.returnToPending(c.req.param('id'), body.revision, body.note as string | undefined));
});

transactionRoutes.post('/', async (c) => {
  const { repo } = await requireScope(c);
  const roster = await repo.roster();
  const { value, fields } = validateTxInput(await c.req.json().catch(() => null), roster);
  if (!value) return c.json({ error: 'Invalid transaction', fields }, 400);
  return c.json(await repo.insertTransaction(value as never), 201);
});

transactionRoutes.post('/bulk', async (c) => {
  const { repo } = await requireScope(c);
  const roster = await repo.roster();
  const body = await c.req.json().catch(() => null) as { transactions?: unknown } | null;
  if (!body || !Array.isArray(body.transactions)) {
    return c.json({ error: 'Invalid transaction import', fields: { transactions: 'Expected an array' } }, 400);
  }
  if (body.transactions.length === 0) {
    return c.json({ error: 'Invalid transaction import', fields: { transactions: 'Expected a non-empty array' } }, 400);
  }
  if (body.transactions.length > MAX_BULK_BATCH) {
    return c.json({
      error: 'Invalid transaction import',
      fields: { transactions: `At most ${MAX_BULK_BATCH} items` },
    }, 400);
  }
  const fields: Record<string, string> = {};
  const parsed: unknown[] = [];
  body.transactions.forEach((raw, i) => {
    const { value, fields: itemFields } = validateTxInput(raw, roster);
    if (!value) for (const [k, v] of Object.entries(itemFields)) fields[`transactions[${i}].${k}`] = v;
    else parsed.push(value);
  });
  if (Object.keys(fields).length > 0) {
    return c.json({ error: 'Invalid transaction import', fields }, 400);
  }
  return c.json(await repo.insertTransactionsBulk(parsed as never), 201);
});

/**
 * Accept flow for "Suggest Categories" (Phase 6). The client computes
 * suggestions itself (deterministic preview, no server round trip needed
 * for that part); this endpoint only applies the ones the user accepted,
 * atomically, and re-guards every invariant server-side rather than
 * trusting the client's preview: category must currently be `Other`, and
 * the row must still be active and undeleted. See
 * ScopedRepository.applyCategorySuggestions for the guard.
 */
transactionRoutes.post('/apply-category-suggestions', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null) as { updates?: unknown } | null;
  if (!body || !Array.isArray(body.updates) || body.updates.length === 0) {
    return c.json({
      error: 'Invalid category suggestion batch',
      fields: { updates: 'Expected a non-empty array' },
    }, 400);
  }
  if (body.updates.length > MAX_BULK_BATCH) {
    return c.json({
      error: 'Invalid category suggestion batch',
      fields: { updates: `At most ${MAX_BULK_BATCH} items` },
    }, 400);
  }

  const fields: Record<string, string> = {};
  const parsed: { id: string; category: string; revision: number }[] = [];
  body.updates.forEach((raw, i) => {
    if (!isPlainObject(raw)) { fields[`updates[${i}]`] = 'Expected an object'; return; }
    if (!expectedRevision(raw.revision)) fields[`updates[${i}].revision`] = 'Expected expense revision';
    const id = trimmedString(raw.id, ID_MAX_LEN);
    const category = trimmedString(raw.category, CATEGORY_MAX_LEN);
    if (id === null) fields[`updates[${i}].id`] = 'Expected a non-empty string';
    if (category === null) fields[`updates[${i}].category`] = 'Expected a non-empty string';
    else if (category === 'Other') fields[`updates[${i}].category`] = 'A suggestion must not target Other';
    if (id !== null && category !== null && category !== 'Other') parsed.push({ id, category, revision: raw.revision as number });
  });
  if (Object.keys(fields).length > 0) {
    return c.json({ error: 'Invalid category suggestion batch', fields }, 400);
  }

  return c.json(await repo.applyCategorySuggestions(parsed));
});

transactionRoutes.patch('/:id', async (c) => {
  const { repo } = await requireScope(c);
  const roster = await repo.roster();
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  const { value, fields } = validateTxPatch(body, roster);
  if (!value) return c.json({ error: 'Invalid transaction', fields }, 400);
  return c.json(await repo.updateTransaction(c.req.param('id'), value as never, body.revision));
});

transactionRoutes.delete('/:id', async (c) => {
  const { repo } = await requireScope(c);
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body) || !expectedRevision(body.revision)) return c.json({ error: 'Expected expense revision' }, 400);
  await repo.softDeleteTransaction(c.req.param('id'), body.revision);
  return c.body(null, 204);
});
