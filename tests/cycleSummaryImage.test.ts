import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CycleSummaryImage from '../src/components/CycleSummaryImage';
import type { CycleSummary } from '../src/lib/cycleSummary';

const person = (id: string, name: string, paidCents: number, shareCents: number) =>
  ({ id, name, color: '#f59e0b', paidCents, shareCents, netCents: paidCents - shareCents });

const summary: CycleSummary = {
  householdName: 'Road Trip Crew', status: 'closed', closedDate: '2026-10-06',
  dateStart: '2026-10-03', dateEnd: '2026-10-04', totalCents: 1100,
  people: [person('h', 'Hugo', 1000, 434), person('y', 'Yuki', 100, 333), person('k', 'Ken', 0, 333)],
  items: [
    { id: 't1', date: '2026-10-03', name: 'Blue Bottle Coffee', payerName: 'Hugo', amountCents: 1000,
      shares: { h: 334, y: 333, k: 333 }, extraCent: ['h'] },
    { id: 't2', date: '2026-10-04', name: 'Parking', payerName: 'Yuki', amountCents: 100,
      shares: { h: 100 }, extraCent: [] },
  ],
  transfers: [{ fromName: 'Yuki', toName: 'Hugo', amountCents: 233 }, { fromName: 'Ken', toName: 'Hugo', amountCents: 333 }],
};

const render = (s: CycleSummary, detailed: boolean) =>
  renderToStaticMarkup(React.createElement(CycleSummaryImage, { summary: s, detailed, generatedOn: '2026-10-21' }))
    .replaceAll('&#x27;', "'");

describe('CycleSummaryImage, summary only', () => {
  const html = render(summary, false);
  it('shows Settle up and People without items or the cent footnote', () => {
    expect(html).toContain('Settle up');
    expect(html).toContain('People');
    expect(html).not.toContain('Paid by');
    expect(html).not.toContain('* Includes an extra 1¢');
    expect(html).toMatch(/data-summary-image="true"[^>]*style="[^"]*width:400px/);
  });
  it('signs Net so it never relies on color alone', () => {
    expect(html).toContain('+$5.66');
    expect(html).toContain('−$2.33');
  });
});

describe('CycleSummaryImage, detailed grid', () => {
  const html = render(summary, true);
  it('sizes the image to its table', () => {
    expect(html).toMatch(/data-summary-image="true"[^>]*style="[^"]*width:max-content;min-width:400px/);
  });
  it('stretches the grid to the image width when the header is wider', () => {
    expect(html).toMatch(/<table style="[^"]*min-width:100%/);
  });
  it('puts person columns in member order', () => {
    const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    expect(head.indexOf('Hugo')).toBeLessThan(head.indexOf('Yuki'));
    expect(head.indexOf('Yuki')).toBeLessThan(head.indexOf('Ken'));
  });
  it('marks the leftover cent and explains it', () => {
    expect(html).toMatch(/\$3\.34<span[^>]*>\*<\/span>/);
    expect(html).toContain("* Includes an extra 1¢ because the bill doesn't split evenly.");
    expect(html).toContain('Paid by Hugo');
  });
  it('ends the grid with Share, Paid, Net rows in that order', () => {
    const foot = html.slice(html.lastIndexOf('</tbody>') - 3000);
    expect(foot.indexOf('>Share<')).toBeLessThan(foot.indexOf('>Paid<'));
    expect(foot.indexOf('>Paid<')).toBeLessThan(foot.indexOf('>Net<'));
  });
  it('wraps long item names instead of widening the image', () => {
    const long = { ...summary, items: [{ ...summary.items[1], name: 'X'.repeat(120) }] };
    const cell = render(long, true).match(/<td[^>]*style="([^"]*)"[^>]*>X{120}/);
    expect(cell?.[1]).toContain('max-width:240px');
    expect(cell?.[1]).toContain('white-space:normal');
  });
});

describe('CycleSummaryImage, Settle up', () => {
  it('keeps the given transfer order', () => {
    const html = render(summary, false);
    expect(html.indexOf('Yuki</b> pays')).toBeLessThan(html.indexOf('Ken</b> pays'));
  });
  it('says everyone is square with no transfers', () => {
    expect(render({ ...summary, transfers: [] }, false)).toContain('Everyone is square.');
  });
});
