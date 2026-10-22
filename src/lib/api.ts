import type { Bootstrap, Transaction, QueueItem, Cycle, CycleGroup, Settlement, ExpenseHistoryEvent, CloseCycleInput, ReminderCompletion } from '../types';
import { CATEGORIES, canonicalCategory, categoryOptions } from '../constants';

export class ApiError extends Error {
  /** `reason` is a machine-readable code some routes return alongside the
   * message, so callers can branch on the failure kind without matching text. */
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (res.status === 401) throw new ApiError(401, 'Signed out');
  if (!res.ok) {
    const body = await res.json<{ error?: string; reason?: string }>()
      .catch((): { error?: string; reason?: string } => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.reason);
  }
  if (res.status === 204) return undefined as T;
  return res.json<T>();
}

const canonicalTransaction = (row: Transaction): Transaction => ({
  ...row, category: canonicalCategory(row.category),
});
const canonicalQueueItem = (row: QueueItem): QueueItem => ({
  ...row, category: row.category === null ? null : canonicalCategory(row.category),
});
function canonicalBootstrap(data: Bootstrap): Bootstrap {
  if (!data.household) return data;
  const customCategories = categoryOptions(data.household.customCategories)
    .filter((category) => !CATEGORIES.includes(category));
  return {
    ...data,
    household: { ...data.household, customCategories },
    transactions: data.transactions.map(canonicalTransaction),
    queue: data.queue.map(canonicalQueueItem),
    categoryPreferences: Object.fromEntries(Object.entries(data.categoryPreferences)
      .map(([merchant, category]) => [merchant, canonicalCategory(category)])),
  };
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap').then(canonicalBootstrap),

  archivedTransactions: () =>
    request<Transaction[]>('/api/transactions?status=archived')
      .then((rows) => rows.map(canonicalTransaction)),

  createTransaction: (input: unknown) =>
    request<Transaction>('/api/transactions', { method: 'POST', body: JSON.stringify(input) }),

  createTransactions: (transactions: unknown[]) =>
    request<Transaction[]>('/api/transactions/bulk', {
      method: 'POST', body: JSON.stringify({ transactions }),
    }),

  updateTransaction: (id: string, patch: unknown, revision: number) =>
    request<Transaction>(`/api/transactions/${id}`, {
      method: 'PATCH', body: JSON.stringify({ ...(patch as object), revision }),
    }),

  splitTransaction: (id: string, transactionId: string, amountCents: number, revision: number) =>
    request<{ original: Transaction; separated: Transaction }>(`/api/transactions/${id}/split`, {
      method: 'POST', body: JSON.stringify({ transactionId, amountCents, revision }),
    }),

  splitQueueItem: (id: string, queueItemId: string, amountCents: number, revision: number) =>
    request<{ original: QueueItem; separated: QueueItem }>(`/api/queue/${encodeURIComponent(id)}/split`, {
      method: 'POST', body: JSON.stringify({ queueItemId, amountCents, revision }),
    }),

  deleteTransaction: (id: string, revision: number) =>
    request<void>(`/api/transactions/${id}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),

  expenseHistory: (expenseId: string) => request<ExpenseHistoryEvent[]>(`/api/transactions/history/${encodeURIComponent(expenseId)}`),

  returnToPending: (id: string, revision: number, note?: string) =>
    request<QueueItem>(`/api/transactions/${id}/pending`, { method: 'POST', body: JSON.stringify({ revision, note }) }),

  /** Accept flow for the "Suggest Categories" workflow (Phase 6). Atomic on the server. */
  applyCategorySuggestions: (updates: Array<{ id: string; category: string; revision: number }>) =>
    request<{ applied: string[]; skipped: string[] }>('/api/transactions/apply-category-suggestions', {
      method: 'POST', body: JSON.stringify({ updates }),
    }),

  createQueueItem: (input: unknown) =>
    request<QueueItem>('/api/queue', { method: 'POST', body: JSON.stringify(input) }),

  createQueueItems: (items: unknown[]) =>
    request<{
      created: QueueItem[];
      summary: { inserted: number; duplicate: number; rejected: number };
    }>('/api/queue/bulk', { method: 'POST', body: JSON.stringify({ items }) }),

  updateQueueItem: (id: string, patch: unknown, revision: number) =>
    request<QueueItem>(`/api/queue/${id}`, { method: 'PATCH', body: JSON.stringify({ ...(patch as object), revision }) }),

  deleteQueueItem: (id: string, revision: number) =>
    request<void>(`/api/queue/${id}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),

  deleteQueueItems: (ids: string[], revisions: Record<string, number>) =>
    request<{ deletedIds: string[] }>('/api/queue/delete-bulk', {
      method: 'POST', body: JSON.stringify({ ids, revisions }),
    }).then((result) => result.deletedIds),

  confirmQueueItem: (id: string, transactionId: string, transaction: unknown, revision: number) =>
    request<Transaction>(`/api/queue/${id}/confirm`, {
      method: 'POST', body: JSON.stringify({ transactionId, transaction, revision }),
    }),

  cycles: () => request<Array<Cycle & { settlement: Settlement; groups: CycleGroup[] }>>('/api/cycles'),

  cycle: (id: string) =>
    request<{ cycle: Cycle; transactions: Transaction[]; settlement: Settlement }>(
      `/api/cycles/${id}`).then((result) => ({
        ...result, transactions: result.transactions.map(canonicalTransaction),
      })),

  closeCycle: (input: CloseCycleInput) =>
    request<Cycle>('/api/cycles/close', {
      method: 'POST', body: JSON.stringify(input),
    }),

  settleCycle: (id: string) =>
    request<Cycle>(`/api/cycles/${id}/settle`, { method: 'POST' }),

  unsettleCycle: (id: string) =>
    request<Cycle>(`/api/cycles/${id}/unsettle`, { method: 'POST' }),

  updateHousehold: (patch: unknown) =>
    request<unknown>('/api/household', { method: 'PATCH', body: JSON.stringify(patch) }),

  upsertMember: (input: unknown) =>
    request<unknown>('/api/members', { method: 'POST', body: JSON.stringify(input) }),

  upsertCard: (input: unknown) =>
    request<unknown>('/api/cards', { method: 'POST', body: JSON.stringify(input) }),

  deleteCard: (id: string) =>
    request<void>(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  reorderCards: (ids: string[]) =>
    request<unknown>('/api/cards/order', { method: 'PUT', body: JSON.stringify({ ids }) }),

  deleteMember: (id: string) =>
    request<void>(`/api/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  reorderMembers: (ids: string[]) =>
    request<unknown>('/api/members/order', { method: 'PUT', body: JSON.stringify({ ids }) }),

  previewCardHistory: (input: unknown) =>
    request<{ cycles: number; expenses: number }>('/api/cards?preview=1', { method: 'POST', body: JSON.stringify(input) }),

  reminders: (month: string) => request<ReminderCompletion[]>(`/api/reminders?month=${month}`),

  setReminder: (month: string, reminderId: string, done: boolean) =>
    request<ReminderCompletion[]>('/api/reminders', { method: 'PUT', body: JSON.stringify({ month, reminderId, done }) }),

  parseReceipt: async (file: File) => {
    const res = await fetch('/api/ai/parse-receipt', { method: 'POST', body: file });
    if (!res.ok) {
      const body = await res.json<{ error?: string }>().catch((): { error?: string } => ({}));
      throw new ApiError(res.status, body.error ?? 'Could not read that receipt');
    }
    return res.json<{
      date: string | null;
      store: string | null;
      amountCents: number | null;
      category: string | null;
      statementTotalCents?: number | null;
      itemsTotalCents?: number;
      reconciled?: boolean;
      transactions?: Array<{
        date: string | null;
        store: string | null;
        amountCents: number | null;
        category: string | null;
      }>;
    }>();
  },

  exportUrl: '/api/export',
};
