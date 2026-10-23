import type { GroupSummary, Bootstrap, Member, Transaction, QueueItem, Cycle, CycleGroup, Settlement, ExpenseHistoryEvent, CloseCycleInput, ReminderCompletion } from '../types';
import { CATEGORIES, canonicalCategory, categoryOptions } from '../constants';

export class ApiError extends Error {
  /** `reason` is a machine-readable code some routes return alongside the
   * message, so callers can branch on the failure kind without matching text. */
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

const GROUP_KEY = 'divvy.groupId';

// Read once: another tab may switch groups, and this tab keeps its own.
let groupId: string | null = (() => {
  try { return localStorage.getItem(GROUP_KEY); } catch { return null; }
})();

export const currentGroupId = (): string | null => groupId;

export function setCurrentGroup(id: string | null): void {
  groupId = id;
  try {
    if (id === null) localStorage.removeItem(GROUP_KEY);
    else localStorage.setItem(GROUP_KEY, id);
  } catch { /* storage unavailable: the in-memory choice still applies */ }
}

/** Never sends an empty header: the server reads that as "no group named". */
export const groupHeaders = (id = currentGroupId()): Record<string, string> =>
  id ? { 'x-divvy-group': id } : {};

async function request<T>(path: string, init: RequestInit | undefined, groupHeader: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...groupHeader, ...(init?.headers ?? {}) },
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

function makeApi(headers: () => Record<string, string>) {
  const req = <T>(path: string, init?: RequestInit) => request<T>(path, init, headers());
  return {
    groups: () => req<{ groups: GroupSummary[]; canCreate: boolean }>('/api/groups'),

    createGroup: (input: { name: string; currencyCode: string; timezone: string }) =>
      req<GroupSummary>('/api/groups', { method: 'POST', body: JSON.stringify(input) }),

    bootstrap: () => req<Bootstrap>('/api/bootstrap').then(canonicalBootstrap),

    archivedTransactions: () =>
      req<Transaction[]>('/api/transactions?status=archived')
        .then((rows) => rows.map(canonicalTransaction)),

    createTransaction: (input: unknown) =>
      req<Transaction>('/api/transactions', { method: 'POST', body: JSON.stringify(input) }),

    createTransactions: (transactions: unknown[]) =>
      req<Transaction[]>('/api/transactions/bulk', {
        method: 'POST', body: JSON.stringify({ transactions }),
      }),

    updateTransaction: (id: string, patch: unknown, revision: number) =>
      req<Transaction>(`/api/transactions/${id}`, {
        method: 'PATCH', body: JSON.stringify({ ...(patch as object), revision }),
      }),

    splitTransaction: (id: string, transactionId: string, amountCents: number, revision: number) =>
      req<{ original: Transaction; separated: Transaction }>(`/api/transactions/${id}/split`, {
        method: 'POST', body: JSON.stringify({ transactionId, amountCents, revision }),
      }),

    splitQueueItem: (id: string, queueItemId: string, amountCents: number, revision: number) =>
      req<{ original: QueueItem; separated: QueueItem }>(`/api/queue/${encodeURIComponent(id)}/split`, {
        method: 'POST', body: JSON.stringify({ queueItemId, amountCents, revision }),
      }),

    deleteTransaction: (id: string, revision: number) =>
      req<void>(`/api/transactions/${id}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),

    expenseHistory: (expenseId: string) => req<ExpenseHistoryEvent[]>(`/api/transactions/history/${encodeURIComponent(expenseId)}`),

    returnToPending: (id: string, revision: number, note?: string) =>
      req<QueueItem>(`/api/transactions/${id}/pending`, { method: 'POST', body: JSON.stringify({ revision, note }) }),

    /** Accept flow for the "Suggest Categories" workflow (Phase 6). Atomic on the server. */
    applyCategorySuggestions: (updates: Array<{ id: string; category: string; revision: number }>) =>
      req<{ applied: string[]; skipped: string[] }>('/api/transactions/apply-category-suggestions', {
        method: 'POST', body: JSON.stringify({ updates }),
      }),

    createQueueItem: (input: unknown) =>
      req<QueueItem>('/api/queue', { method: 'POST', body: JSON.stringify(input) }),

    createQueueItems: (items: unknown[]) =>
      req<{
        created: QueueItem[];
        summary: { inserted: number; duplicate: number; rejected: number };
      }>('/api/queue/bulk', { method: 'POST', body: JSON.stringify({ items }) }),

    updateQueueItem: (id: string, patch: unknown, revision: number) =>
      req<QueueItem>(`/api/queue/${id}`, { method: 'PATCH', body: JSON.stringify({ ...(patch as object), revision }) }),

    deleteQueueItem: (id: string, revision: number) =>
      req<void>(`/api/queue/${id}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),

    deleteQueueItems: (ids: string[], revisions: Record<string, number>) =>
      req<{ deletedIds: string[] }>('/api/queue/delete-bulk', {
        method: 'POST', body: JSON.stringify({ ids, revisions }),
      }).then((result) => result.deletedIds),

    confirmQueueItem: (id: string, transactionId: string, transaction: unknown, revision: number) =>
      req<Transaction>(`/api/queue/${id}/confirm`, {
        method: 'POST', body: JSON.stringify({ transactionId, transaction, revision }),
      }),

    cycles: () => req<Array<Cycle & { settlement: Settlement; groups: CycleGroup[] }>>('/api/cycles'),

    cycle: (id: string) =>
      req<{ cycle: Cycle; transactions: Transaction[]; settlement: Settlement }>(
        `/api/cycles/${id}`).then((result) => ({
          ...result, transactions: result.transactions.map(canonicalTransaction),
        })),

    closeCycle: (input: CloseCycleInput) =>
      req<Cycle>('/api/cycles/close', {
        method: 'POST', body: JSON.stringify(input),
      }),

    renameCycle: (id: string, name: string | null) =>
      req<unknown>(`/api/cycles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

    settleCycle: (id: string) =>
      req<Cycle>(`/api/cycles/${id}/settle`, { method: 'POST' }),

    unsettleCycle: (id: string) =>
      req<Cycle>(`/api/cycles/${id}/unsettle`, { method: 'POST' }),

    updateHousehold: (patch: unknown) =>
      req<unknown>('/api/household', { method: 'PATCH', body: JSON.stringify(patch) }),

    upsertMember: (input: unknown) =>
      req<unknown>('/api/members', { method: 'POST', body: JSON.stringify(input) }),

    setSittingOut: (id: string, sittingOut: boolean) =>
      req<Member>(`/api/members/${encodeURIComponent(id)}/sitting-out`, { method: 'PUT', body: JSON.stringify({ sittingOut }) }),

    upsertCard: (input: unknown) =>
      req<unknown>('/api/cards', { method: 'POST', body: JSON.stringify(input) }),

    deleteCard: (id: string) =>
      req<void>(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    reorderCards: (ids: string[]) =>
      req<unknown>('/api/cards/order', { method: 'PUT', body: JSON.stringify({ ids }) }),

    deleteMember: (id: string) =>
      req<void>(`/api/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    reorderMembers: (ids: string[]) =>
      req<unknown>('/api/members/order', { method: 'PUT', body: JSON.stringify({ ids }) }),

    previewCardHistory: (input: unknown) =>
      req<{ cycles: number; expenses: number }>('/api/cards?preview=1', { method: 'POST', body: JSON.stringify(input) }),

    reminders: (month: string) => req<ReminderCompletion[]>(`/api/reminders?month=${month}`),

    setReminder: (month: string, reminderId: string, done: boolean) =>
      req<ReminderCompletion[]>('/api/reminders', { method: 'PUT', body: JSON.stringify({ month, reminderId, done }) }),

    parseReceipt: async (file: File) => {
      const res = await fetch('/api/ai/parse-receipt', { method: 'POST', body: file, headers: headers() });
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

    exportUrl: () => {
      const id = headers()['x-divvy-group'];
      return id ? `/api/export?group=${encodeURIComponent(id)}` : '/api/export';
    },
  };
}

export const api = makeApi(() => groupHeaders());

/** A client pinned to one group, whatever the current selection becomes. */
export const apiFor = (groupId: string) => makeApi(() => groupHeaders(groupId));
