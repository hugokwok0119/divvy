import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ImportResultScreen from '../src/components/ImportResultScreen';
import { describe, it, expect } from 'vitest';
import {
  buildBatchImportSummary, buildImportSummary, isReconciliationFailure,
} from '../src/components/ImportResultScreen';

const rows = (overrides: Partial<{
  date: string | null; store: string | null; amountCents: number | null; category: string | null;
}>[] = []) => overrides.map((r) => ({
  date: r.date ?? '2024-06-01', store: r.store ?? 'Uber', amountCents: r.amountCents ?? 500, category: r.category ?? null,
}));

describe('buildImportSummary', () => {
  it('sums row amounts for the item total when no reconciliation total is given', () => {
    const summary = buildImportSummary({
      fileName: 'statement.csv',
      source: 'csv',
      rows: rows([{ amountCents: 500 }, { amountCents: 700 }]),
      bulk: { summary: { inserted: 2, duplicate: 0, rejected: 0 } },
    });
    expect(summary.itemsTotalCents).toBe(1200);
  });

  it('uses the passed itemsTotalCents over the row sum when given (PDF path)', () => {
    const summary = buildImportSummary({
      fileName: 'statement.pdf',
      source: 'image',
      rows: rows([{ amountCents: 500 }]),
      itemsTotalCents: 999,
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    expect(summary.itemsTotalCents).toBe(999);
  });

  it('marks reconciliation not_applicable by default (CSV has no statement to check)', () => {
    const summary = buildImportSummary({
      fileName: 'a.csv',
      source: 'csv',
      rows: rows([{}]),
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    expect(summary.reconciliationStatus).toBe('not_applicable');
    expect(summary.statementTotalCents).toBeNull();
  });

  it('marks reconciliation matched and carries the statement total when the PDF total matches', () => {
    const summary = buildImportSummary({
      fileName: 'statement.pdf',
      source: 'image',
      rows: rows([{ amountCents: 500 }, { amountCents: 700 }]),
      itemsTotalCents: 1200,
      statementTotalCents: 1200,
      reconciliationStatus: 'matched',
      bulk: { summary: { inserted: 2, duplicate: 0, rejected: 0 } },
    });
    expect(summary.reconciliationStatus).toBe('matched');
    expect(summary.statementTotalCents).toBe(1200);
    expect(summary.outcome).toBe('complete');
  });

  it('creates zero queue rows and reports outcome failed when reconciliation failed, even if a bulk result is somehow passed', () => {
    const summary = buildImportSummary({
      fileName: 'statement.pdf',
      source: 'image',
      rows: rows([{ amountCents: 500 }]),
      itemsTotalCents: 500,
      statementTotalCents: 900,
      reconciliationStatus: 'failed',
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    expect(summary.outcome).toBe('failed');
    expect(summary.insertedCount).toBe(0);
    expect(summary.rejectedCount).toBe(0);
  });

  it('reports outcome failed with the given message when no bulk call was made at all', () => {
    const summary = buildImportSummary({
      fileName: 'receipt.pdf',
      source: 'image',
      rows: [],
      reconciliationStatus: 'failed',
      failureMessage: 'Statement check failed: items total $5.00, statement total $9.00. No rows were imported.',
    });
    expect(summary.outcome).toBe('failed');
    expect(summary.rowsFound).toBe(0);
    expect(summary.insertedCount).toBe(0);
    expect(summary.failureMessage).toContain('Statement check failed');
  });

  it('falls back to a generic failure message when none is given and there is nothing to import', () => {
    const summary = buildImportSummary({ fileName: 'empty.csv', source: 'csv', rows: [] });
    expect(summary.outcome).toBe('failed');
    expect(summary.failureMessage).toMatch(/no rows/i);
  });

  it('marks outcome failed (not success) when reconciliation matched but the bulk call itself failed', () => {
    const summary = buildImportSummary({
      fileName: 'statement.pdf',
      source: 'image',
      rows: rows([{ amountCents: 500 }]),
      itemsTotalCents: 500,
      statementTotalCents: 500,
      reconciliationStatus: 'matched',
      failureMessage: 'Could not add to the review queue.',
    });
    expect(summary.reconciliationStatus).toBe('matched');
    expect(summary.outcome).toBe('failed');
    expect(summary.insertedCount).toBe(0);
  });

  it('marks outcome partial (not complete) when some rows were rejected as already-imported', () => {
    const summary = buildImportSummary({
      fileName: 'retry.csv',
      source: 'csv',
      rows: rows([{ amountCents: 500 }, { amountCents: 700 }]),
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 1 } },
    });
    expect(summary.outcome).toBe('partial');
    expect(summary.insertedCount).toBe(1);
    expect(summary.rejectedCount).toBe(1);
  });

  it('marks outcome complete only when every row was freshly inserted', () => {
    const summary = buildImportSummary({
      fileName: 'clean.csv',
      source: 'csv',
      rows: rows([{ amountCents: 500 }]),
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    expect(summary.outcome).toBe('complete');
  });

  it('counts potential duplicates from the bulk summary', () => {
    const summary = buildImportSummary({
      fileName: 'a.csv',
      source: 'csv',
      rows: rows([{ amountCents: 500 }, { amountCents: 500 }]),
      bulk: { summary: { inserted: 2, duplicate: 1, rejected: 0 } },
    });
    expect(summary.potentialDuplicates).toBe(1);
  });

  it('counts rows needing attention: any row missing date, store, or amount', () => {
    const summary = buildImportSummary({
      fileName: 'messy.csv',
      source: 'csv',
      rows: [
        { date: '2024-06-01', store: 'Uber', amountCents: 500, category: null },
        { date: null, store: 'Lyft', amountCents: 700, category: null },
        { date: '2024-06-02', store: null, amountCents: 300, category: null },
        { date: '2024-06-03', store: 'Shell', amountCents: null, category: null },
      ],
      bulk: { summary: { inserted: 4, duplicate: 0, rejected: 0 } },
    });
    expect(summary.rowsNeedingAttention).toBe(3);
  });

  it('counts rows where a category was inferred', () => {
    const summary = buildImportSummary({
      fileName: 'a.csv',
      source: 'csv',
      rows: [
        { date: '2024-06-01', store: 'Uber', amountCents: 500, category: 'Transport' },
        { date: '2024-06-02', store: 'Unknown Shop', amountCents: 700, category: null },
      ],
      bulk: { summary: { inserted: 2, duplicate: 0, rejected: 0 } },
    });
    expect(summary.categoriesInferred).toBe(1);
  });

  it('carries file name, source, and row count through unchanged', () => {
    const summary = buildImportSummary({
      fileName: 'chase-june.pdf',
      source: 'image',
      rows: rows([{}, {}, {}]),
      bulk: { summary: { inserted: 3, duplicate: 0, rejected: 0 } },
    });
    expect(summary.fileName).toBe('chase-june.pdf');
    expect(summary.source).toBe('image');
    expect(summary.rowsFound).toBe(3);
  });
});

describe('isReconciliationFailure', () => {
  it('recognises the reconciliation reason code the ai route returns', () => {
    expect(isReconciliationFailure('reconciliation_failed')).toBe(true);
  });

  it('does not treat another failure kind as a reconciliation failure', () => {
    expect(isReconciliationFailure('quota_exhausted')).toBe(false);
  });

  it('treats a missing reason as not a reconciliation failure', () => {
    expect(isReconciliationFailure(undefined)).toBe(false);
  });
});

describe('buildBatchImportSummary', () => {
  it('combines counts and marks mixed CSV/PDF uploads complete', () => {
    const csv = buildImportSummary({
      fileName: 'one.csv', source: 'csv', rows: rows([{}]),
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    const pdf = buildImportSummary({
      fileName: 'two.pdf', source: 'image', rows: rows([{}, {}]),
      itemsTotalCents: 1000, statementTotalCents: 1000, reconciliationStatus: 'matched',
      bulk: { summary: { inserted: 2, duplicate: 1, rejected: 0 } },
    });

    expect(buildBatchImportSummary([csv, pdf])).toMatchObject({
      fileName: '2 files', source: 'mixed', outcome: 'complete', rowsFound: 3,
      insertedCount: 3, potentialDuplicates: 1,
    });
  });

  it('marks batch partial and names failed file when another file succeeds', () => {
    const good = buildImportSummary({
      fileName: 'good.csv', source: 'csv', rows: rows([{}]),
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    const bad = buildImportSummary({
      fileName: 'bad.pdf', source: 'image', rows: [], reconciliationStatus: 'failed',
      failureMessage: 'Could not verify statement total.',
    });

    const batch = buildBatchImportSummary([good, bad]);
    expect(batch.outcome).toBe('partial');
    expect(batch.failureMessage).toContain('bad.pdf');
    expect(batch.insertedCount).toBe(1);
  });
});


describe('batch file result cards', () => {
  it('retains successful and failed same-name files with their individual totals and results', () => {
    const good = buildImportSummary({
      fileName: 'same.pdf', source: 'image', rows: rows([{ amountCents: 500 }]),
      statementTotalCents: 500, reconciliationStatus: 'matched',
      bulk: { summary: { inserted: 1, duplicate: 0, rejected: 0 } },
    });
    const bad = buildImportSummary({
      fileName: 'same.pdf', source: 'image', rows: [],
      reconciliationStatus: 'failed', failureMessage: 'Cannot reconcile this file.',
    });
    const batch = buildBatchImportSummary([good, bad]);
    expect(batch.files).toEqual([good, bad]);
    const html = renderToStaticMarkup(React.createElement(ImportResultScreen, { summary: batch, onClose: () => {} }));
    const cards = [...html.matchAll(/<section\b[^>]*>(.*?)<\/section>/g)].map((match) => match[1]);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('same.pdf');
    expect(cards[0]).toContain('Import complete');
    expect(cards[0]).toContain('$5.00');
    expect(cards[0]).toContain('Matches printed statement total');
    expect(cards[1]).toContain('same.pdf');
    expect(cards[1]).toContain('Import failed');
    expect(cards[1]).toContain('Cannot reconcile this file.');
    expect(cards[1]).toContain('Did not match printed statement total');
  });
});
