// Data access only through scope.repo.
import { Hono, type Context } from 'hono';
import { requireScope, requireOwner } from '../lib/scope';
import { validateHouseholdPatch, validateMemberInput, validateCardInput, validateReminderInput, validateOrderInput, REMINDER_MONTH } from '../lib/validate';
import type { Env } from '../index';

export const householdRoutes = new Hono<{ Bindings: Env }>();

householdRoutes.patch('/', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { value, fields } = validateHouseholdPatch(await c.req.json().catch(() => null));
  if (!value) return c.json({ error: 'Invalid household update', fields }, 400);
  return c.json(await scope.repo.updateHousehold(value));
});

async function reorder(c: Context<{ Bindings: Env }>, kind: 'members' | 'cards') {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { ids, fields } = validateOrderInput(await c.req.json().catch(() => null));
  if (!ids) return c.json({ error: 'Invalid order', fields }, 400);
  await scope.repo.reorder(kind, ids);
  return c.json({ ids });
}

export const memberRoutes = new Hono<{ Bindings: Env }>();

memberRoutes.get('/', async (c) => c.json(await (await requireScope(c)).repo.publicMembers()));

memberRoutes.post('/', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { value, fields } = validateMemberInput(await c.req.json().catch(() => null), { requireId: true });
  if (!value) return c.json({ error: 'Invalid member', fields }, 400);
  return c.json(await scope.repo.upsertMember(value as never), 201);
});

memberRoutes.put('/order', (c) => reorder(c, 'members'));

memberRoutes.patch('/:id', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { value, fields } = validateMemberInput(await c.req.json().catch(() => null), { requireId: false });
  if (!value) return c.json({ error: 'Invalid member', fields }, 400);
  return c.json(await scope.repo.upsertMember({ ...value, id: c.req.param('id') } as never));
});

memberRoutes.put('/:id/sitting-out', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.sittingOut !== 'boolean') {
    return c.json({ error: 'Invalid sitting out', fields: { sittingOut: 'Expected a boolean' } }, 400);
  }
  return c.json(await scope.repo.setSittingOut(c.req.param('id'), body.sittingOut));
});

memberRoutes.delete('/:id', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  await scope.repo.archiveMember(c.req.param('id'));
  return c.body(null, 204);
});

export const cardRoutes = new Hono<{ Bindings: Env }>();

cardRoutes.get('/', async (c) => c.json(await (await requireScope(c)).repo.cards()));

cardRoutes.post('/', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { value, fields } = validateCardInput(await c.req.json().catch(() => null), { requireId: true });
  if (!value) return c.json({ error: 'Invalid card', fields }, 400);
  // Dry run: same validation and permission as the save, but writes nothing.
  if (c.req.query('preview') === '1') return c.json(await scope.repo.cardHistoryScope(value as never));
  return c.json(await scope.repo.upsertCard(value as never), 201);
});

cardRoutes.put('/order', (c) => reorder(c, 'cards'));

cardRoutes.patch('/:id', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const { value, fields } = validateCardInput(await c.req.json().catch(() => null), { requireId: false });
  if (!value) return c.json({ error: 'Invalid card', fields }, 400);
  return c.json(await scope.repo.upsertCard({ ...value, id: c.req.param('id') } as never));
});

cardRoutes.delete('/:id', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  await scope.repo.archiveCard(c.req.param('id'));
  return c.body(null, 204);
});

// Any household member may tick or untick, like ordinary ledger writes.
export const reminderRoutes = new Hono<{ Bindings: Env }>();

reminderRoutes.get('/', async (c) => {
  const scope = await requireScope(c);
  const month = c.req.query('month') ?? '';
  if (!REMINDER_MONTH.test(month)) return c.json({ error: 'Invalid month', fields: { month: 'Expected YYYY-MM' } }, 400);
  return c.json(await scope.repo.reminderCompletions(month));
});

reminderRoutes.put('/', async (c) => {
  const scope = await requireScope(c);
  const { value, fields } = validateReminderInput(await c.req.json().catch(() => null));
  if (!value) return c.json({ error: 'Invalid reminder', fields }, 400);
  return c.json(await scope.repo.setReminderCompletion(value.month, value.reminderId, value.done));
});
