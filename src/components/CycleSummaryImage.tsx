import React from 'react';
import type { CycleSummary, SummaryPerson } from '../lib/cycleSummary';
import { formatCentsWithSymbol, formatDateSpan } from '../lib/money';

// Colors are inline hex, not Tailwind tokens, so the exported JPG never depends on
// CSS that html-to-image fails to copy.
const INK = '#0f172a', MUTED = '#64748b', SOFT = '#475569', LINE = '#e2e8f0', RULE = '#94a3b8';
const POS = '#15803d', NEG = '#b91c1c', ZEBRA = '#f8fafc';

const signed = (cents: number) =>
  `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatCentsWithSymbol(Math.abs(cents))}`;
const netColor = (cents: number) => (cents > 0 ? POS : cents < 0 ? NEG : INK);

const Dot = ({ color }: { color: string }) => (
  <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: color, marginRight: 6, verticalAlign: 1 }} />
);

const th: React.CSSProperties = { padding: '8px', borderBottom: `1px solid ${RULE}`, color: INK, fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px', borderBottom: `1px solid #f1f5f9`, verticalAlign: 'top', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { ...td, textAlign: 'right' };

function Header({ summary, peopleCount }: { summary: CycleSummary; peopleCount: number }) {
  const span = summary.dateStart && summary.dateEnd ? formatDateSpan(summary.dateStart, summary.dateEnd) : 'No items';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, paddingBottom: 24 }}>
      <div>
        <div className="text-body2" style={{ color: MUTED, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' }}>Divvy · Cycle summary</div>
        <div className="text-heading1" style={{ fontWeight: 600, margin: '4px 0' }}>{summary.householdName}</div>
        <div className="text-body2" style={{ color: SOFT }}>
          {span} · {summary.items.length} items · {peopleCount} people
        </div>
        <div className="text-body2" style={{ color: SOFT }}>
          Closed {formatDateSpan(summary.closedDate, summary.closedDate)}{' '}
          <span style={{ fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: '#f1f5f9', border: `1px solid ${LINE}` }}>
            {summary.status === 'settled' ? 'Settled' : 'Not settled'}
          </span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="text-body2" style={{ color: MUTED }}>Cycle total</div>
        <div className="text-heading1" style={{ fontWeight: 600 }}>{formatCentsWithSymbol(summary.totalCents)}</div>
      </div>
    </div>
  );
}

function SettleUp({ summary, columns }: { summary: CycleSummary; columns: number }) {
  return (
    <section style={{ background: INK, color: '#fff', borderRadius: 12, padding: '16px 24px', marginBottom: 24 }}>
      <div className="text-heading2" style={{ fontWeight: 600, marginBottom: 8 }}>Settle up</div>
      {summary.transfers.length === 0 ? <div style={{ color: '#cbd5e1' }}>Everyone is square.</div> : (
        <div style={{ columns, columnGap: 48, maxWidth: columns * 300 + (columns - 1) * 48 }}>
          {summary.transfers.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '4px 0', color: '#cbd5e1', breakInside: 'avoid' }}>
              <span><b style={{ color: '#fff' }}>{t.fromName}</b> pays <b style={{ color: '#fff' }}>{t.toName}</b></span>
              <b style={{ color: '#fff' }}>{formatCentsWithSymbol(t.amountCents)}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PeopleTable({ people }: { people: SummaryPerson[] }) {
  return (
    <section>
      <div className="text-heading2" style={{ fontWeight: 600, marginBottom: 8 }}>People</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead className="text-body2"><tr>
          <th style={th}>Person</th><th style={{ ...th, textAlign: 'right' }}>Paid</th>
          <th style={{ ...th, textAlign: 'right' }}>Share</th><th style={{ ...th, textAlign: 'right' }}>Net</th>
        </tr></thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id}>
              <td style={td}><Dot color={p.color} />{p.name}</td>
              <td style={num}>{formatCentsWithSymbol(p.paidCents)}</td>
              <td style={num}>{formatCentsWithSymbol(p.shareCents)}</td>
              <td style={{ ...num, fontWeight: 600, color: netColor(p.netCents) }}>{signed(p.netCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-body2" style={{ color: SOFT, marginTop: 12 }}>
        Net: + gets money back, − pays. Share is each person's part of every item they were in.
      </div>
    </section>
  );
}

function ItemGrid({ summary }: { summary: CycleSummary }) {
  const people = summary.people;
  const col = (i: number): React.CSSProperties => ({ ...num, minWidth: 76, background: i % 2 ? ZEBRA : undefined });
  const amount: React.CSSProperties = { ...num, borderRight: `1px solid #cbd5e1` };
  const foot = (label: string, cells: (p: SummaryPerson) => React.ReactNode, total: React.ReactNode, weight: number, top = false) => {
    const border: React.CSSProperties = { borderBottom: 'none', borderTop: top ? `1px solid ${RULE}` : undefined, fontWeight: weight };
    return (
      <tr>
        <td colSpan={2} style={{ ...td, ...border }}>{label}</td>
        <td style={{ ...amount, ...border }}>{total}</td>
        {people.map((p, i) => <td key={p.id} style={{ ...col(i), ...border }}>{cells(p)}</td>)}
      </tr>
    );
  };
  return (
    <table style={{ borderCollapse: 'collapse' }}>
      <thead className="text-body2"><tr>
        <th style={th}>Date</th><th style={th}>Item</th>
        <th style={{ ...th, textAlign: 'right', borderRight: `1px solid #cbd5e1` }}>Amount</th>
        {people.map((p, i) => <th key={p.id} style={{ ...th, textAlign: 'right', minWidth: 76, background: i % 2 ? ZEBRA : undefined }}><Dot color={p.color} />{p.name}</th>)}
      </tr></thead>
      <tbody>
        {summary.items.map((item, row) => (
          <tr key={item.id}>
            <td style={{ ...td, color: MUTED }}>{row > 0 && summary.items[row - 1].date === item.date ? '' : formatDateSpan(item.date, item.date).replace(/, \d{4}$/, '')}</td>
            <td style={{ ...td, maxWidth: 240, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {item.name}
              <div className="text-body2" style={{ color: MUTED }}>Paid by {item.payerName}</div>
            </td>
            <td style={{ ...amount, fontWeight: 600 }}>{formatCentsWithSymbol(item.amountCents)}</td>
            {people.map((p, i) => item.shares[p.id] === undefined
              ? <td key={p.id} style={{ ...col(i), color: '#cbd5e1' }}>—</td>
              : <td key={p.id} style={col(i)}>
                  {formatCentsWithSymbol(item.shares[p.id])}
                  {item.extraCent.includes(p.id) && <span style={{ display: 'inline-block', width: 0, overflow: 'visible' }}>*</span>}
                </td>)}
          </tr>
        ))}
        {foot('Share', (p) => formatCentsWithSymbol(p.shareCents), formatCentsWithSymbol(summary.totalCents), 600, true)}
        {foot('Paid', (p) => formatCentsWithSymbol(p.paidCents), formatCentsWithSymbol(summary.totalCents), 400)}
        {foot('Net', (p) => <span style={{ color: netColor(p.netCents) }}>{signed(p.netCents)}</span>, '', 600)}
      </tbody>
    </table>
  );
}

/** The exported image. `detailed` adds the per-item grid; otherwise Settle up and People only. */
export default function CycleSummaryImage({ summary, detailed, generatedOn }: {
  summary: CycleSummary; detailed: boolean; generatedOn: string;
}) {
  const transfers = summary.transfers.length;
  const columns = !detailed || transfers <= 4 ? 1 : transfers <= 8 ? 2 : 3;
  return (
    <div
      data-summary-image="true"
      style={{
        ...(detailed ? { width: 'max-content', minWidth: 400 } : { width: 400 }),
        background: '#fff', color: INK, padding: 24, fontFamily: 'Inter, sans-serif', fontVariantNumeric: 'tabular-nums',
      }}
      className="text-body1"
    >
      <Header summary={summary} peopleCount={summary.people.length} />
      <SettleUp summary={summary} columns={columns} />
      {detailed ? <ItemGrid summary={summary} /> : <PeopleTable people={summary.people} />}
      {detailed && (
        <div className="text-body2" style={{ color: SOFT, marginTop: 12 }}>
          * Includes an extra 1¢ because the bill doesn't split evenly. Net: + gets money back, − pays.
        </div>
      )}
      <div className="text-body2" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 16, borderTop: `1px solid ${LINE}`, color: RULE }}>
        <span>Generated by Divvy</span><span>{formatDateSpan(generatedOn, generatedOn)}</span>
      </div>
    </div>
  );
}
