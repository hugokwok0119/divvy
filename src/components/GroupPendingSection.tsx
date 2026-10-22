import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiFor, ApiError } from '../lib/api';
import { memberColorAt } from '../lib/memberColors';
import { categoryOptions, generateId } from '../constants';
import type { Bootstrap, GroupSummary, Member, QueueItem, TxInput } from '../types';
import TransactionList from './TransactionList';

/** Approve one Pending row in the group `client` is pinned to. */
export async function confirmQueueItemWith(client: typeof api, item: QueueItem) {
  if (!item.date || !item.store?.trim() || item.amountCents == null || !item.category || !item.payerId || !['equal', 'single', 'custom'].includes(item.splitType ?? '')) {
    throw new Error('Fill in date, store, amount, category, payer and split before approving.');
  }
  const input: TxInput = {
    id: generateId(), date: item.date, store: item.store, amountCents: item.amountCents,
    category: item.category, payerId: item.payerId, cardId: item.cardId,
    splitType: item.splitType as TxInput['splitType'],
    splitRule: item.splitRuleJson ? JSON.parse(item.splitRuleJson) : null,
  };
  return client.confirmQueueItem(item.id, input.id, input, item.revision);
}

/** A group's name and people, above its Pending rows. */
export const GroupPendingHeader: React.FC<{ id: string; name: string; members: Member[] }> = ({ id, name, members }) => (
  <div className="mb-3">
    <h3 id={id} className="text-heading2 text-slate-800">{name}</h3>
    <ul aria-label={`People in ${name}`} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-body2 text-slate-600">
      {members.map((member, index) => member.archivedAt === null && (
        <li key={member.id} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: memberColorAt(index) }} />
          {member.displayName}
        </li>
      ))}
    </ul>
  </div>
);

interface Props {
  group: GroupSummary;
  reloadKey: number;
  onChanged(): void;
  /** Task 13 adds the toolbar button that calls this. */
  onSendToGroup?(rows: QueueItem[], fromGroupId: string): void;
  showToast: (message: string, type?: 'error' | 'success') => void;
}

/** Another group's Pending rows on the dashboard, read and saved through that group's own client. */
const GroupPendingSection: React.FC<Props> = ({ group, reloadKey, onChanged, showToast }) => {
  const client = useMemo(() => apiFor(group.id), [group.id]);
  const [data, setData] = useState<Bootstrap | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const next = await client.bootstrap();
      if (request === latest.current) setData(next); // a focus reload may finish after a save's reload
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : `Could not load ${group.name}.`, 'error');
    }
  }, [client, group.name, showToast]);
  useEffect(() => { void reload(); }, [reload, reloadKey]);
  const saved = async <T,>(result: T) => {
    await reload();
    onChanged();
    return result;
  };

  const [filterDateStart, setFilterDateStart] = useState('');
  const [filterDateEnd, setFilterDateEnd] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterPayerId, setFilterPayerId] = useState('');
  const [filterCardId, setFilterCardId] = useState('');

  const headingId = `pending-group-${group.id}`;
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <GroupPendingHeader id={headingId} name={data?.household.name ?? group.name} members={data?.members ?? []} />
      {data && (
        <TransactionList
          transactions={data.transactions}
          pendingItems={data.queue}
          mode="pending"
          client={client}
          onQueueUpdate={async (id, patch, revision) => saved(await client.updateQueueItem(id, patch, revision))}
          onQueueBreakdown={async (id, queueItemId, amountCents, revision) => saved(await client.splitQueueItem(id, queueItemId, amountCents, revision))}
          onQueueDelete={async (id, revision) => saved(await client.deleteQueueItem(id, revision))}
          onQueueDeleteMany={async (ids, revisions) => { await saved(await client.deleteQueueItems(ids, revisions)); }}
          onApprove={async (item) => saved(await confirmQueueItemWith(client, item))}
          onChanged={() => saved(undefined)}
          members={data.members}
          cards={data.cards}
          categories={categoryOptions(data.household.customCategories)}
          categoryPreferences={data.categoryPreferences}
          showToast={showToast}
          filterDateStart={filterDateStart}
          setFilterDateStart={setFilterDateStart}
          filterDateEnd={filterDateEnd}
          setFilterDateEnd={setFilterDateEnd}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterPayerId={filterPayerId}
          setFilterPayerId={setFilterPayerId}
          filterCardId={filterCardId}
          setFilterCardId={setFilterCardId}
        />
      )}
    </section>
  );
};

export default GroupPendingSection;
