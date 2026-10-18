import React, { useState } from 'react';
import type { QueueItem, QueueItemInput, Transaction, Member, Card } from '../types';
import { categoryOptions } from '../constants';
import TransactionList from './TransactionList';
export { findMatchingTransaction } from './ledger';

interface ReviewQueueProps {
  queue: QueueItem[];
  members: Member[];
  cards: Card[];
  customCategories: string[];
  transactions: Transaction[];
  onUpdate: (id: string, patch: Partial<QueueItemInput>, revision: number) => Promise<QueueItem>;
  onDelete: (id: string, revision: number) => Promise<void>;
  onDeleteMany: (ids: string[], revisions: Record<string, number>) => Promise<void>;
  onConfirm: (item: QueueItem) => Promise<Transaction>;
  showToast: (message: string, type?: 'error' | 'success') => void;
}
/** Compatibility entry point for standalone Pending views. */
export default function ReviewQueue(props: ReviewQueueProps) {
  const [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [category, setCategory] = useState(''),
    [payer, setPayer] = useState(''),
    [card, setCard] = useState('');
  return (
    <TransactionList
      mode="pending"
      pendingItems={props.queue}
      transactions={props.transactions}
      members={props.members}
      cards={props.cards}
      categories={categoryOptions(props.customCategories)}
      onQueueUpdate={props.onUpdate}
      onQueueDelete={props.onDelete}
      onQueueDeleteMany={props.onDeleteMany}
      onApprove={props.onConfirm}
      showToast={props.showToast}
      filterDateStart={start}
      setFilterDateStart={setStart}
      filterDateEnd={end}
      setFilterDateEnd={setEnd}
      filterCategory={category}
      setFilterCategory={setCategory}
      filterPayerId={payer}
      setFilterPayerId={setPayer}
      filterCardId={card}
      setFilterCardId={setCard}
    />
  );
}
