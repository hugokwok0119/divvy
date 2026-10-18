
import React, { useEffect, useMemo, useState } from 'react';
import { Transaction, Member, Card } from '../types';
import { api, ApiError } from '../lib/api';
import { formatCentsWithSymbol, aggregateAnalytics, formatMonthLabel, computeYAxisTicks } from '../lib/money';
import { ArrowLeft, TrendingUp, PieChart, Filter, X } from 'lucide-react';
import TransactionList from './TransactionList';

interface Props {
  members: Member[];
  cards: Card[];
  categories: string[];
  onBack: () => void;
  showToast: (message: string, type?: 'error' | 'success') => void;
}

const AnalyticsPage: React.FC<Props> = ({ members, cards, categories, onBack, showToast }) => {
  const [rows, setRows] = useState<Transaction[] | null>(null);

  const [filterDateStart, setFilterDateStart] = useState('');
  const [filterDateEnd, setFilterDateEnd] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterPayerId, setFilterPayerId] = useState('');
  const [filterCardId, setFilterCardId] = useState('');

  useEffect(() => {
    api.archivedTransactions()
      .then(setRows)
      .catch((err) => showToast(err instanceof ApiError ? err.message : 'Could not load analytics.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClearFilters = () => {
    setFilterDateStart('');
    setFilterDateEnd('');
    setFilterCategory('');
    setFilterPayerId('');
    setFilterCardId('');
  };

  const hasActiveFilters = filterDateStart || filterDateEnd || filterCategory || filterPayerId || filterCardId;

  const stats = useMemo(() => {
    const filtered = (rows ?? []).filter((tx) => {
      if (filterDateStart && tx.date < filterDateStart) return false;
      if (filterDateEnd && tx.date > filterDateEnd) return false;
      if (filterCategory && tx.category !== filterCategory) return false;
      if (filterPayerId && tx.payerId !== filterPayerId) return false;
      if (filterCardId && tx.cardId !== filterCardId) return false;
      return true;
    });

    return { ...aggregateAnalytics(filtered), filtered };
  }, [rows, filterDateStart, filterDateEnd, filterCategory, filterPayerId, filterCardId]);

  const monthKeys = Object.keys(stats.monthTotals).sort();
  const sortedCategories = Object.entries(stats.categoryTotals).sort((a, b) => b[1] - a[1]);
  const monthValues = Object.values(stats.monthTotals);
  // Zero is always in range so a month can dip below the baseline without
  // rescaling everything else; the ",1" floor on maxVal keeps an all-zero
  // series from dividing by zero.
  const minMonthVal = Math.min(0, ...monthValues);
  const maxMonthVal = Math.max(0, ...monthValues, 1);
  const yAxisTicks = computeYAxisTicks(minMonthVal, maxMonthVal, 4);
  const narrowMonthStride = Math.max(1, Math.ceil((monthKeys.length - 1) / 3));
  const wideMonthStride = Math.max(1, Math.ceil((monthKeys.length - 1) / 7));

  // Plot area occupies y 20..80 of the 0..100 viewBox; the bottom 20 units
  // are reserved for month labels. Shared by data points and axis ticks so
  // they stay aligned.
  const valueToY = (val: number) => {
    const range = maxMonthVal - minMonthVal || 1;
    return 100 - 20 - ((val - minMonthVal) / range) * 60;
  };

  const getPointCoords = (idx: number, val: number) => {
    const sidePaddingPercent = 5;
    const usableWidth = 100 - sidePaddingPercent * 2;
    let x = 50;
    if (monthKeys.length > 1) x = sidePaddingPercent + (idx / (monthKeys.length - 1)) * usableWidth;
    return { x, y: valueToY(val) };
  };

  const getLinePoints = () => {
    if (monthKeys.length === 0) return '';
    return monthKeys.map((m, idx) => {
      const { x, y } = getPointCoords(idx, stats.monthTotals[m]);
      return `${x},${y}`;
    }).join(' ');
  };

  if (!rows) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 font-bold transition-colors shadow-sm"
          >
            <ArrowLeft size={18} />
            Back
          </button>
          <h2 className="text-heading1 font-bold text-slate-800 flex items-center gap-2">
            <TrendingUp className="text-blue-600" />
            Spending Analytics
          </h2>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-y-2">
          <div className="flex items-center gap-2 text-slate-500 text-sm font-bold">
            <Filter size={16} aria-hidden="true" /> Filters:
          </div>
          <div className="flex flex-wrap items-center gap-4 font-mono">
            <div className="text-right">
              <div className="text-body2 font-bold uppercase text-slate-400">Net Spending</div>
              <div className="text-lg font-bold text-slate-800">{formatCentsWithSymbol(stats.netSpending)}</div>
            </div>
            <div className="text-right">
              <div className="text-body2 font-bold uppercase text-slate-400">Gross Purchases</div>
              <div className="text-lg font-bold text-slate-800">{formatCentsWithSymbol(stats.grossPurchases)}</div>
            </div>
            <div className="text-right">
              <div className="text-body2 font-bold uppercase text-slate-400">Refunds</div>
              <div className="text-lg font-bold text-emerald-600">{formatCentsWithSymbol(stats.refunds)}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase" aria-hidden="true">Dates:</span>
            <input type="date" aria-label="Filter from date" className="text-xs outline-none bg-white text-slate-700 font-medium" value={filterDateStart} onChange={(e) => setFilterDateStart(e.target.value)} />
            <span className="text-slate-400" aria-hidden="true">-</span>
            <input type="date" aria-label="Filter to date" className="text-xs outline-none bg-white text-slate-700 font-medium" value={filterDateEnd} onChange={(e) => setFilterDateEnd(e.target.value)} />
          </div>

          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase" aria-hidden="true">Cat:</span>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} aria-label="Filter by category" className="text-xs outline-none text-slate-700 bg-transparent cursor-pointer min-w-[80px]">
              <option value="">All</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase" aria-hidden="true">Payer:</span>
            <select value={filterPayerId} onChange={(e) => setFilterPayerId(e.target.value)} aria-label="Filter by payer" className="text-xs outline-none text-slate-700 bg-transparent cursor-pointer min-w-[80px]">
              <option value="">All</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5 shadow-sm">
            <span className="text-xs font-bold text-slate-500 uppercase" aria-hidden="true">Card:</span>
            <select value={filterCardId} onChange={(e) => setFilterCardId(e.target.value)} aria-label="Filter by card" className="text-xs outline-none text-slate-700 bg-transparent cursor-pointer min-w-[80px]">
              <option value="">All</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {hasActiveFilters && (
            <button onClick={handleClearFilters} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition-colors flex items-center gap-1 ml-auto">
              <X size={12} aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid auto-rows-fr grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Monthly Trend */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col min-w-0">
          <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
            <TrendingUp size={20} className="text-emerald-500" /> Monthly Trend
          </h3>
          <div className="relative w-full flex">
            {monthKeys.length === 0 && <p className="text-slate-400 min-h-[180px] w-full flex items-center justify-center text-center">No data available for current filters</p>}

            {monthKeys.length > 0 && (
              <>
                <div className="relative shrink-0 w-20 text-body2 text-slate-400 font-bold">
                  {yAxisTicks.map((v) => (
                    <div key={v} className="absolute right-1 -translate-y-1/2 whitespace-nowrap" style={{ top: `${valueToY(v)}%` }}>
                      {formatCentsWithSymbol(v)}
                    </div>
                  ))}
                </div>
                <div className="flex-1 min-w-0 relative aspect-[5/3] min-h-[180px] max-h-[320px]">
                  <svg aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {yAxisTicks.map((v) => (
                      <line key={v} x1="5" x2="95" y1={valueToY(v)} y2={valueToY(v)} stroke="#e2e8f0" vectorEffect="non-scaling-stroke" />
                    ))}
                    <line x1="5" x2="95" y1={valueToY(0)} y2={valueToY(0)} stroke="#94a3b8" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                    <polyline
                      points={getLinePoints()}
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>

                  {monthKeys.map((m, idx) => {
                    const val = stats.monthTotals[m];
                    const { x, y } = getPointCoords(idx, val);
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-label={`${formatMonthLabel(m)}: ${formatCentsWithSymbol(val)}`}
                        className="group absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full hover:z-10 focus:z-10 focus-visible:outline-2 focus-visible:outline-emerald-600"
                        style={{ left: `${x}%`, top: `${y}%` }}
                      >
                        <span aria-hidden="true" className="w-2 h-2 rounded-full bg-white border-2 border-emerald-500 group-hover:bg-emerald-100 group-focus:bg-emerald-100" />
                        <span aria-hidden="true" className={`absolute bottom-full mb-1 bg-slate-800 text-white text-body2 py-1 px-2 rounded text-center shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity pointer-events-none ${x < 25 ? 'left-0' : x > 75 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>
                          <span className="block font-bold">{formatMonthLabel(m)}</span>
                          <span className="block">{formatCentsWithSymbol(val)}</span>
                        </span>
                      </button>
                    );
                  })}

                  {monthKeys.map((m, idx) => {
                    const { x } = getPointCoords(idx, 0);
                    const last = monthKeys.length - 1;
                    const showNarrow = idx === last || (idx % narrowMonthStride === 0 && last - idx >= narrowMonthStride);
                    const showWide = idx === last || (idx % wideMonthStride === 0 && last - idx >= wideMonthStride);
                    return (
                      <div key={m} aria-hidden="true" className={`absolute bottom-0 text-body2 text-slate-400 font-bold -translate-x-1/2 text-center whitespace-nowrap ${showNarrow ? 'block' : 'hidden'} ${showWide ? 'sm:block' : 'sm:hidden'}`} style={{ left: `${x}%` }}>
                        {formatMonthLabel(m)}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Same data as the chart above, in a screen-reader-only table: the
              chart's hover tooltips and axis ticks are visual affordances,
              not the only way to reach the numbers. */}
          {monthKeys.length > 0 && (
            <table className="sr-only">
              <caption>Monthly net spending</caption>
              <thead>
                <tr><th scope="col">Month</th><th scope="col">Net amount</th></tr>
              </thead>
              <tbody>
                {monthKeys.map((m) => (
                  <tr key={m}>
                    <th scope="row">{formatMonthLabel(m)}</th>
                    <td>{formatCentsWithSymbol(stats.monthTotals[m])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Category Breakdown */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm min-h-0 flex flex-col">
          <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
            <PieChart size={20} className="text-purple-500" /> Top Categories
            <span className="text-xs font-normal text-slate-400">(% of gross purchases; refunds shown separately above)</span>
          </h3>
          <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar flex-1 min-h-0 basis-0">
            {sortedCategories.length === 0 && <p className="text-slate-400 text-center pt-10">No data available</p>}
            {sortedCategories.map(([cat, val]) => {
              const percentage = stats.grossPurchases > 0 ? (val / stats.grossPurchases) * 100 : 0;
              return (
                <div key={cat} className="group cursor-default">
                  <div className="flex justify-between text-xs font-bold text-slate-600 mb-1">
                    <span>{cat}</span>
                    <div className="flex gap-2">
                      <span className="text-slate-500">{percentage.toFixed(1)}%</span>
                      <span className="text-slate-800 font-bold">{formatCentsWithSymbol(val)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div style={{ width: `${percentage}%` }} className="h-full bg-purple-400 group-hover:bg-purple-600 transition-colors" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Detailed List */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Detailed Transactions</h3>
        </div>
        <TransactionList
          transactions={stats.filtered}
          members={members}
          cards={cards}
          categories={categories}
          readOnly
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
      </div>
    </div>
  );
};

export default AnalyticsPage;
