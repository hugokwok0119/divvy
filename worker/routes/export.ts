// Data access only through scope.repo.
import { Hono } from 'hono';
import { requireScope, requireOwner } from '../lib/scope';
import type { Env } from '../index';

export const exportRoutes = new Hono<{ Bindings: Env }>();

exportRoutes.get('/', async (c) => {
  const scope = await requireScope(c);
  requireOwner(scope);
  const data = await scope.repo.exportAll();
  c.header('content-disposition', 'attachment; filename="divvy-export.json"');
  return c.json(data);
});
