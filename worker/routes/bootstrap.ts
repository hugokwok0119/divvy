// Every handler in this file reaches data only through scope.repo.
// Never import drizzle or env.DB here.
import { Hono } from 'hono';
import { requireScope } from '../lib/scope';
import type { Env } from '../index';

export const bootstrap = new Hono<{ Bindings: Env }>();

bootstrap.get('/', async (c) => {
  const scope = await requireScope(c);
  const { repo } = scope;

  const [household, members, cards, transactions, queue, cycles, prefs] = await Promise.all([
    repo.household(), repo.publicMembers(), repo.cards(),
    repo.activeTransactions(), repo.queueItems(), repo.cycles(), repo.categoryPreferences(),
  ]);

  return c.json({
    me: { memberId: scope.memberId, role: scope.role },
    household: {
      id: household.id,
      name: household.name,
      currencyCode: household.currencyCode,
      timezone: household.timezone,
      customCategories: JSON.parse(household.customCategoriesJson),
      currentCycleName: household.currentCycleName,
      rentReminder: household.rentReminder === 1,
    },
    members, cards, transactions, queue, cycles,
    categoryPreferences: prefs,
  });
});
