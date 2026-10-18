import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import ReviewQueue from '../src/components/ReviewQueue';
import type { QueueItem } from '../src/types';

const item: QueueItem = {
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  expenseId: 'expense-test', revision: 1, editedByMemberId: null, editedByName: null, sourceFileId: null, sourceFileName: null, reviewNote: null, splitRuleJson: null, updatedAt: 0,
  id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 586, category: null,
  payerId: null, cardId: null, splitType: null, isDuplicate: 0, source: 'csv',
};

const renderQueue = (date: string | null) => renderToStaticMarkup(React.createElement(ReviewQueue, {
  queue: [{ ...item, date }], members: [], cards: [], customCategories: [], transactions: [],
  onUpdate: async () => item, onDelete: async () => {}, onDeleteMany: async () => {},
  onConfirm: async () => { throw new Error('Not called by static markup tests'); }, showToast: () => {},
}));

describe('review date field', () => {
  it('shows the transaction date as an editable native date input', () => {
    const input = renderQueue('2024-06-09').match(/<input\b[^>]*aria-label="Date"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('value="2024-06-09"');
    expect(input).not.toMatch(/\s(?:disabled|readonly)(?:\s|=|\/?>)/i);
  });

  it('leaves unknown dates blank with an accessible label', () => {
    const input = renderQueue(null).match(/<input\b[^>]*aria-label="Date"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('value=""');
    expect(input).toContain('aria-label="Date"');
  });
});


describe('review file cards', () => {
  it('puts duplicate warnings first within each PDF card while preserving row order and input', () => {
    const queue: QueueItem[] = [
      { ...item, id: 'a-normal-1', store: 'Alpha ordinary one', sourceFileId: 'upload-a', sourceFileName: 'alpha.pdf' },
      { ...item, id: 'b-normal', store: 'Beta ordinary', sourceFileId: 'upload-b', sourceFileName: 'beta.pdf' },
      { ...item, id: 'a-duplicate-1', store: 'Alpha duplicate one', isDuplicate: 1, sourceFileId: 'upload-a', sourceFileName: 'alpha.pdf' },
      { ...item, id: 'a-normal-2', store: 'Alpha ordinary two', sourceFileId: 'upload-a', sourceFileName: 'alpha.pdf' },
      { ...item, id: 'b-duplicate', store: 'Beta duplicate', isDuplicate: 1, sourceFileId: 'upload-b', sourceFileName: 'beta.pdf' },
      { ...item, id: 'a-duplicate-2', store: 'Alpha duplicate two', isDuplicate: 1, sourceFileId: 'upload-a', sourceFileName: 'alpha.pdf' },
    ];
    const original = structuredClone(queue);
    const html = renderToStaticMarkup(React.createElement(ReviewQueue, {
      queue, members: [], cards: [], customCategories: [], transactions: [],
      onUpdate: async () => item, onDelete: async () => {}, onDeleteMany: async () => {},
      onConfirm: async () => { throw new Error('Not called by static markup tests'); }, showToast: () => {},
    }));
    const cards = [...html.matchAll(/<section\b[^>]*aria-label="(?!Pending ledger)[^"]*"[^>]*>(.*?)<\/section>/g)].map((match) => match[1]);
    expect(queue).toEqual(original);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('alpha.pdf');
    expect(cards[1]).toContain('beta.pdf');
    const rows = cards.map((card) => [...card.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)]
      .map(([, row]) => ({
        store: row.match(/aria-label="Select ([^"]+)"/)?.[1],
        warning: row.includes('Potential duplicate'),
      })));
    expect(rows).toEqual([
      [
        { store: 'Alpha duplicate one', warning: true },
        { store: 'Alpha duplicate two', warning: true },
        { store: 'Alpha ordinary one', warning: false },
        { store: 'Alpha ordinary two', warning: false },
      ],
      [
        { store: 'Beta duplicate', warning: true },
        { store: 'Beta ordinary', warning: false },
      ],
    ]);
  });

  it('keeps same-name uploads separate and includes legacy rows', () => {
    const html = renderToStaticMarkup(React.createElement(ReviewQueue, {
      queue: [
        { ...item, id: 'a1', sourceFileId: 'upload-a', sourceFileName: 'same.csv' },
        { ...item, id: 'b1', sourceFileId: 'upload-b', sourceFileName: 'same.csv' },
        { ...item, id: 'a2', sourceFileId: 'upload-a', sourceFileName: 'same.csv' },
        { ...item, id: 'old' },
      ],
      members: [], cards: [], customCategories: [], transactions: [],
      onUpdate: async () => item, onDelete: async () => {}, onDeleteMany: async () => {},
      onConfirm: async () => { throw new Error('Not called by static markup tests'); }, showToast: () => {},
    }));
    const cards = [...html.matchAll(/<section\b[^>]*aria-label="(?!Pending ledger)[^"]*"[^>]*>(.*?)<\/section>/g)].map((match) => match[1]);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('same.csv');
    expect(cards[0]).toContain('· 2');
    expect(cards[0].match(/aria-label="Date"/g)).toHaveLength(2);
    expect(cards[1]).toContain('same.csv');
    expect(cards[1]).toContain('· 1');
    expect(cards[2]).toContain('Other review items');
    expect(html.match(/aria-label="Select all visible expenses"/g)).toHaveLength(1);
    expect(html.match(/Approve All/g)).toHaveLength(1);
  });
});
