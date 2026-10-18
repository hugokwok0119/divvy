// Data access only through scope.repo.
import { Hono } from 'hono';
import { requireScope, requireOwner } from '../lib/scope';
import { validateCloseCycle } from '../lib/validate';
import type { Env } from '../index';

export const cycleRoutes = new Hono<{ Bindings: Env }>();

cycleRoutes.get('/', async (c) => {
  const { repo } = await requireScope(c);
  const [cycles, groups] = await Promise.all([repo.cycles(), repo.cycleGroups()]);
  return c.json(await Promise.all(cycles.map(async (cy) => ({
    ...cy,
    settlement: await repo.cycleSettlement(cy.id),
    groups: groups.filter((g) => g.cycleId === cy.id).map(({ cycleId: _, ...g }) => g),
  }))));
});

cycleRoutes.get('/:id', async (c) => {
  const { repo } = await requireScope(c);
  const id = c.req.param('id');
  return c.json({
    cycle: await repo.requireCycle(id),
    transactions: await repo.transactionsByCycle(id),
    settlement: await repo.cycleSettlement(id),
  });
});

cycleRoutes.post('/close', async (c) => {
  const { repo } = await requireScope(c);
  const { value, fields } = validateCloseCycle(await c.req.json().catch(() => null));
  if (!value) return c.json({ error: 'Invalid cycle close request', fields }, 400);
  return c.json(await repo.closeCycle(value.cycleId, value.transactionIds, value.revisions), 201);
});

cycleRoutes.post('/:id/settle', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  return c.json(await scope.repo.settleCycle(c.req.param('id')));
});

cycleRoutes.post('/:id/unsettle', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  return c.json(await scope.repo.unsettleCycle(c.req.param('id')));
});
