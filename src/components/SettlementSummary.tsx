import { formatCentsWithSymbol } from '../lib/money';
import type { Settlement, Member } from '../types';
import { Wallet, Receipt } from 'lucide-react';

interface SettlementSummaryProps {
  settlement: Settlement;
  members: Member[];
  onCloseCycle: () => void;
  closableCount: number;
  closableTotalCents: number;
}

export default function SettlementSummary({
  settlement, members, onCloseCycle, closableCount, closableTotalCents,
}: SettlementSummaryProps) {
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? 'Unknown';
  const isSettled = settlement.transfers.length === 0;

  return (
    <div className="bg-slate-900 text-white rounded-xl shadow-lg p-3">
      <h2 className="text-heading2 mb-2 flex items-center gap-2">
        <Wallet size={18} className="text-blue-400" aria-hidden="true" />
        Current Cycle
      </h2>

      <div className="space-y-2">
        <div className="text-center py-2 px-3 bg-slate-800 rounded-lg border border-slate-700">
          <p className="text-slate-400 text-body2 font-semibold uppercase tracking-wider mb-1">Net Balances</p>

          {isSettled ? (
            <div className="text-heading2 text-green-400">All Settled</div>
          ) : (
            <div className="space-y-1">
              {settlement.transfers.map((t) => (
                <div key={`${t.from}-${t.to}`} className="text-body1">
                  <span className="font-medium text-slate-200">{nameOf(t.from)}</span> owes{' '}
                  <span className="font-medium text-slate-200">{nameOf(t.to)}</span>{' '}
                  <span className="font-semibold text-white">{formatCentsWithSymbol(t.amountCents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onCloseCycle}
          disabled={closableCount === 0}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-body1 font-semibold py-2 pointer-coarse:min-h-11 rounded-lg flex items-center justify-center gap-2 transition-colors shadow-md active:scale-95 duration-100 disabled:opacity-40 disabled:active:scale-100"
        >
          <Receipt size={16} aria-hidden="true" />
          Close {closableCount} transactions ({formatCentsWithSymbol(closableTotalCents)})
        </button>
      </div>
    </div>
  );
}
