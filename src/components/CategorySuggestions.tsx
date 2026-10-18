import React, { useEffect, useState } from 'react';
import { CategorySuggestion } from '../lib/category';
import { Sparkles, X, Check, CheckCheck } from 'lucide-react';

interface CategorySuggestionsProps {
  suggestions: CategorySuggestion[];
  onApply: (updates: Array<{ id: string; category: string }>) => Promise<unknown>;
  onClose: () => void;
}

/**
 * Review UI for the "Suggest Categories" workflow (Phase 6): shows each
 * `Other` transaction alongside the historical merchant that produced its
 * proposed category and how confident the match is, and lets the user
 * accept one, accept a selection, or accept every exact match at once.
 * Never writes anything itself — every apply goes through the atomic
 * `onApply` callback the caller supplies.
 */
const CategorySuggestions: React.FC<CategorySuggestionsProps> = ({ suggestions, onApply, onClose }) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const exactIds = suggestions.filter((s) => s.confidence === 'exact').map((s) => s.transactionId);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const apply = async (ids: string[]) => {
    const byId = new Map(suggestions.map((s) => [s.transactionId, s.suggestedCategory]));
    const updates = ids
      .filter((id) => byId.has(id))
      .map((id) => ({ id, category: byId.get(id)! }));
    if (updates.length === 0) return;
    setIsSubmitting(true);
    try {
      await onApply(updates);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-suggestions-heading"
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2 shrink-0">
          <h3 id="category-suggestions-heading" className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Sparkles size={20} aria-hidden="true" className="text-blue-500" /> Suggest Categories
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {suggestions.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">
            No suggestions right now — every "Other" transaction is either unmatched or already reviewed.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-4 shrink-0">
              Matched against your category history. Nothing changes until you accept.
            </p>

            <div className="space-y-2 overflow-y-auto pr-2 custom-scrollbar mb-4">
              {suggestions.map((s) => (
                <div
                  key={s.transactionId}
                  className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.transactionId)}
                    onChange={() => toggle(s.transactionId)}
                    aria-label={`Select suggestion for ${s.store}: ${s.suggestedCategory}`}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{s.store}</div>
                    <div className="text-xs text-slate-500">
                      Other &rarr; <span className="font-medium text-slate-700">{s.suggestedCategory}</span>
                      <span className="mx-1">&middot;</span>
                      matched "{s.sourceMerchant}"
                    </div>
                  </div>
                  <span
                    className={`text-body2 font-bold uppercase px-2 py-1 rounded-full shrink-0 ${
                      s.confidence === 'exact'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {s.confidence === 'exact' ? 'Exact match' : 'Partial match'}
                  </span>
                  <button
                    onClick={() => void apply([s.transactionId])}
                    disabled={isSubmitting}
                    className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-40 shrink-0"
                    title="Accept this suggestion"
                    aria-label={`Accept suggestion for ${s.store}`}
                  >
                    <Check size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-3 shrink-0 pt-2 border-t border-slate-200">
              <button
                onClick={() => void apply(exactIds)}
                disabled={isSubmitting || exactIds.length === 0}
                className="flex-1 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <CheckCheck size={16} /> Accept all exact matches ({exactIds.length})
              </button>
              <button
                onClick={() => void apply(Array.from(selectedIds))}
                disabled={isSubmitting || selectedIds.size === 0}
                className="flex-1 py-2 bg-slate-800 text-white font-bold rounded-lg hover:bg-slate-900 disabled:opacity-50"
              >
                Accept selected ({selectedIds.size})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CategorySuggestions;
