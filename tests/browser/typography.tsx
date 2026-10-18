import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '../../src/index.css';

flushSync(() => createRoot(document.getElementById('demo')!).render(
  <main className="mx-auto max-w-xl space-y-4 p-6">
    <h1 className="text-heading1">Divvy</h1>
    <section className="rounded-xl bg-white p-6 shadow">
      <h2 className="text-heading2">Expense details</h2>
      <p className="text-body1">Shared expenses and allocations.</p>
      <p data-check="warning" role="alert" className="text-body1 text-amber-800">Possible duplicate. Review before approving.</p>
      <p data-check="note" className="text-body1">Review note: Check the receipt total.</p>
      <p className="text-body2 text-slate-500">Edited by Alex · October 14</p>
      <label className="text-body2" htmlFor="typography-amount">Amount</label>
      <input id="typography-amount" className="block rounded border p-2 text-sm" defaultValue="12.34" />
      <button type="button" className="mt-3 text-body1 font-semibold">Save changes</button>
    </section>
    <div data-check="aliases">
      <span className="text-xs">Metadata alias</span>
      <span className="text-sm">Body alias</span>
      <span className="text-base">Base alias</span>
      <span className="text-lg">Section alias</span>
      <span className="text-xl">Dialog alias</span>
      <span className="text-2xl">Page alias</span>
    </div>
  </main>,
));

const status = document.querySelector('[role="status"]')!;
try {
  const check = (selector: string, size: number, lineHeight: number, weight: number) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    const style = getComputedStyle(element);
    if (style.fontSize !== `${size}px` || style.lineHeight !== `${lineHeight}px` || style.fontWeight !== `${weight}`) {
      throw new Error(`${selector}: got ${style.fontSize}/${style.lineHeight}/${style.fontWeight}, expected ${size}px/${lineHeight}px/${weight}`);
    }
  };
  check('h1', 24, 32, 600);
  check('h2', 18, 28, 600);
  check('p.text-body1', 14, 20, 400);
  check('[data-check="warning"]', 14, 20, 400);
  check('[data-check="note"]', 14, 20, 400);
  check('p.text-body2', 12, 16, 400);
  check('label', 12, 16, 400);
  check('button', 14, 20, 600);
  check('input', matchMedia('(pointer: coarse)').matches ? 16 : 14, 20, 400);
  for (const [className, size, lineHeight, weight] of [
    ['text-xs', 12, 16, 400], ['text-sm', 14, 20, 400], ['text-base', 14, 20, 400],
    ['text-lg', 18, 28, 600], ['text-xl', 18, 28, 600], ['text-2xl', 24, 32, 600],
  ] as const) check(`[data-check="aliases"] .${className}`, size, lineHeight, weight);
  status.textContent = 'PASS: four typography roles, utility aliases, warnings, notes, labels, controls, and input size.';
} catch (error) {
  status.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
}
