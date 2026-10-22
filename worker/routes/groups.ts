// Data access only through worker/lib/groups.ts.
import { Hono } from 'hono';
import { listGroups, createGroup, requireGroupCreator } from '../lib/groups';
import { validateGroupInput } from '../lib/validate';
import type { Env } from '../index';

export const groupRoutes = new Hono<{ Bindings: Env }>();

groupRoutes.get('/', async (c) => c.json(await listGroups(c)));

groupRoutes.post('/', async (c) => {
  // Refuse a missing session or a non-owner before reporting body errors.
  await requireGroupCreator(c);
  const { value, fields } = validateGroupInput(await c.req.json().catch(() => null));
  if (!value) return c.json({ error: 'Invalid group', fields }, 400);
  return c.json(await createGroup(c, value), 201);
});
