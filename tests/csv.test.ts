import { describe, it, expect } from 'vitest';
import { parseCsv } from '../src/lib/csv';

describe('parseCsv', () => {
  it('parses a headered file', () => {
    const rows = parseCsv('Date,Description,Amount\n2024-06-09,Uber,5.86');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2024-06-09', store: 'Uber', amountCents: 586 });
    expect(rows[0].issues).toEqual([]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('Date,Description,Amount\n2024-06-09,"Shop, The",12.00');
    expect(rows[0].store).toBe('Shop, The');
  });

  it('handles escaped quotes inside quoted fields', () => {
    const rows = parseCsv('Date,Description,Amount\n2024-06-09,"He said ""hi""",1.00');
    expect(rows[0].store).toBe('He said "hi"');
  });

  it('normalizes MM/DD/YYYY dates', () => {
    expect(parseCsv('Date,Description,Amount\n06/09/2024,Uber,5.86')[0].date).toBe('2024-06-09');
  });

  it('keeps negative amounts as refunds', () => {
    expect(parseCsv('Date,Description,Amount\n2024-05-22,Walmart,-3.29')[0].amountCents).toBe(-329);
  });

  it('treats a parenthesised amount as negative', () => {
    expect(parseCsv('Date,Description,Amount\n2024-05-22,Walmart,(3.29)')[0].amountCents).toBe(-329);
  });

  it('records an issue rather than guessing when the amount is unparseable', () => {
    const rows = parseCsv('Date,Description,Amount\n2024-06-09,Uber,not-a-number');
    expect(rows[0].amountCents).toBeNull();
    expect(rows[0].issues).toContain('amount');
  });

  it('never substitutes today for a missing date', () => {
    const rows = parseCsv('Date,Description,Amount\n,Uber,5.86');
    expect(rows[0].date).toBeNull();
    expect(rows[0].issues).toContain('date');
  });

  it('skips blank lines', () => {
    expect(parseCsv('Date,Description,Amount\n\n2024-06-09,Uber,5.86\n\n')).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('Date,Description,Amount\r\n2024-06-09,Uber,5.86\r\n')).toHaveLength(1);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('falls back to positional columns when headers are absent', () => {
    const rows = parseCsv('2024-06-09,Uber,5.86');
    expect(rows[0]).toMatchObject({ date: '2024-06-09', store: 'Uber', amountCents: 586 });
  });

  it('drops a header row whose aliases are not recognised', () => {
    const rows = parseCsv('Posting Date,Merchant,Debit\n2024-06-09,Uber,5.86');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2024-06-09', store: 'Uber', amountCents: 586 });
  });

  it('keeps every row when the file has no header at all', () => {
    const rows = parseCsv('2024-06-09,Uber,5.86\n2024-06-10,Lyft,7.00');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ date: '2024-06-10', store: 'Lyft', amountCents: 700 });
  });

  it('keeps a headerless first row that is missing only its amount', () => {
    const rows = parseCsv('2024-06-09,Uber,\n2024-06-10,Lyft,7.00');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: '2024-06-09', store: 'Uber', amountCents: null });
    expect(rows[0].issues).toContain('amount');
  });
});
