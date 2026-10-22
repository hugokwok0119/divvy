import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { GroupSummary } from '../types';

interface Props {
  groups: GroupSummary[];
  currentId: string | null;
  canCreate: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

const item = 'flex w-full min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100';

/** Menu button (WAI-ARIA pattern): arrows move, Enter or Space picks, Escape closes, focus returns to the button. */
const GroupSwitcher: React.FC<Props> = ({ groups, currentId, canCreate, onSelect, onCreate, open, onOpenChange }) => {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => { setOwnOpen(next); onOpenChange?.(next); };
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = groups.find((g) => g.id === currentId);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const close = (restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); };

  // On open (from this button or another opener), focus the current group, else the first item.
  useEffect(() => {
    if (!isOpen) return;
    (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? items()[0])?.focus();
    const onPointerDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const list = items();
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        ref={button}
        id="group-switcher"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => setOpen(!isOpen)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}
        className="flex min-h-9 pointer-coarse:min-h-11 max-w-full sm:max-w-xs items-center gap-1 rounded-lg px-2 py-1.5 text-body1 font-semibold text-slate-700 hover:bg-slate-100"
      >
        <span className="sr-only">Group: </span>
        <span className="truncate">{current?.name ?? 'Choose a group'}</span>
        <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
      </button>
      {isOpen && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Groups"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 text-slate-700 shadow-2xl"
        >
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="menuitemradio"
              aria-checked={g.id === currentId}
              tabIndex={-1}
              onClick={() => { close(true); if (g.id !== currentId) onSelect(g.id); }}
              className={item}
            >
              <Check size={16} aria-hidden="true" className={`shrink-0 text-blue-600 ${g.id === currentId ? '' : 'invisible'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body1 font-semibold text-slate-800">{g.name}</span>
                {g.pendingCount > 0 && <span className="block text-body2 text-slate-500">{g.pendingCount} pending</span>}
              </span>
            </button>
          ))}
          {canCreate && (
            <>
              {groups.length > 0 && <div role="separator" className="my-1 border-t border-slate-200" />}
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(false); onCreate(); }} className={item}>
                <Plus size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
                <span className="text-body1 font-semibold text-slate-800">New group</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default GroupSwitcher;
