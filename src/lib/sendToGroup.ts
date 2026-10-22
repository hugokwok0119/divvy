import type { Member, QueueItem, QueueItemInput } from '../types';

const nameKey = (name: string) => name.trim().toLowerCase();

/** Copies Pending rows for another group: card and split are cleared, the payer carries over by display name. */
export function planSend(
  rows: QueueItem[], sourceMembers: Member[], targetMembers: Member[], newId: () => string,
): { inputs: QueueItemInput[]; unmatchedPayers: string[] } {
  const unmatched = new Set<string>();
  const inputs = rows.map((row): QueueItemInput => {
    const payer = sourceMembers.find((m) => m.id === row.payerId);
    const matches = payer
      ? targetMembers.filter((m) => m.archivedAt === null && nameKey(m.displayName) === nameKey(payer.displayName))
      : [];
    if (payer && matches.length !== 1) unmatched.add(payer.displayName);
    return {
      id: newId(), date: row.date, store: row.store, amountCents: row.amountCents, category: row.category,
      payerId: matches.length === 1 ? matches[0].id : null, cardId: null, splitType: null, splitRule: null,
      // Legacy rows have no source; the queue validator requires one.
      source: row.source ?? 'manual', sourceFileId: row.sourceFileId, sourceFileName: row.sourceFileName,
    };
  });
  return { inputs, unmatchedPayers: [...unmatched] };
}

/** Creates the copies first, then removes only the originals whose copy exists. `inputs[i]` copies `rows[i]`. */
export async function sendRows(
  deps: { create(inputs: QueueItemInput[]): Promise<string[]>; remove(ids: string[], revisions: Record<string, number>): Promise<void> },
  rows: QueueItem[], inputs: QueueItemInput[],
): Promise<{ result: 'sent' | 'copied-not-removed'; notCopied: number }> {
  const created = new Set(await deps.create(inputs));
  const copied = rows.filter((_, i) => created.has(inputs[i].id));
  const notCopied = rows.length - copied.length;
  if (copied.length === 0) return { result: 'sent', notCopied };
  try {
    await deps.remove(copied.map((r) => r.id), Object.fromEntries(copied.map((r) => [r.id, r.revision])));
    return { result: 'sent', notCopied };
  } catch {
    return { result: 'copied-not-removed', notCopied };
  }
}
