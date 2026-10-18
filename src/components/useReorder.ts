import { useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';

const move = (list: string[], from: string, to: string) => {
  const next = list.filter((id) => id !== from);
  next.splice(list.indexOf(to), 0, from);
  return next;
};

/**
 * Reorders a list by dragging a grip (pointer events, so touch works too) or
 * pressing ArrowUp/ArrowDown on it. Items only move among ids in the same group.
 */
export function useReorder(name: string, ids: string[], groupOf: (id: string) => string, save: (ids: string[]) => Promise<void>) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const dragging = useRef<string | null>(null);
  const refocus = useRef<string | null>(null);
  const order = draft ?? ids;
  const update = (next: string[] | null) => { draftRef.current = next; setDraft(next); };
  const key = (id: string) => `${name}:${groupOf(id)}`;

  // Moving a keyed node can drop focus; put it back on the grip that moved.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    document.querySelector<HTMLElement>(`[data-reorder-grip="${CSS.escape(`${name}:${refocus.current}`)}"]`)?.focus();
    refocus.current = null;
  }, [order, name]);

  const commit = async (next: string[]) => {
    update(next);
    try {
      if (next.join('\n') !== ids.join('\n')) await save(next);
    } finally {
      update(null);
    }
  };

  const item = (id: string) => ({ 'data-reorder-group': key(id), 'data-reorder-id': id });

  const grip = (id: string, label: string) => ({
    type: 'button' as const,
    'aria-label': `Reorder ${label}`,
    title: 'Drag, or use the arrow keys, to reorder',
    'data-reorder-grip': `${name}:${id}`,
    onKeyDown: (e: React.KeyboardEvent) => {
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const peers = order.filter((other) => groupOf(other) === groupOf(id));
      const neighbor = peers[peers.indexOf(id) + step];
      if (!neighbor) return;
      refocus.current = id;
      void commit(move(order, id, neighbor));
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
      dragging.current = id;
      update(order);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragging.current !== id || !draftRef.current) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>(`[data-reorder-group="${CSS.escape(key(id))}"]`)?.dataset.reorderId;
      if (over && over !== id) update(move(draftRef.current, id, over));
    },
    onPointerUp: () => {
      if (dragging.current !== id || !draftRef.current) return;
      dragging.current = null;
      void commit(draftRef.current);
    },
    onPointerCancel: () => { dragging.current = null; update(null); },
  });

  return { order, dragging: draft ? dragging.current : null, item, grip };
}
