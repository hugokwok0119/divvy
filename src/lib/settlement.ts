import type { Cycle } from '../types';

export type MemberId = string;
export type Shares = Record<MemberId, number>;
export type SplitType = 'equal' | 'custom' | 'single';

export interface SplitRule {
  memberId?: MemberId;
  percentages?: Record<MemberId, number>;
}

/**
 * Largest-remainder distribution. Shares always sum to exactly amountCents.
 * Ties are broken by a stable sort on member id.
 *
 * ponytail: the id tie-break means a genuine tie always favours the same
 * member. Rotating the residue by transaction id would remove that bias if a
 * larger group ever uses Divvy regularly.
 */
export function distributeByWeight(amountCents: number, weights: Record<MemberId, number>): Shares {
  const ids = Object.keys(weights).filter((k) => weights[k] > 0).sort();
  if (ids.length === 0) throw new RangeError('No positive weights to distribute across');

  const totalWeight = ids.reduce((s, id) => s + weights[id], 0);
  const sign = amountCents < 0 ? -1 : 1;
  const abs = Math.abs(amountCents);

  const exact = ids.map((id) => (abs * weights[id]) / totalWeight);
  const base = exact.map(Math.floor);
  let remainder = abs - base.reduce((a, b) => a + b, 0);

  const order = ids
    .map((id, i) => ({ i, id, frac: exact[i] - base[i] }))
    .sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1));

  for (let k = 0; k < remainder; k++) base[order[k].i]++;

  const out: Shares = {};
  ids.forEach((id, i) => { out[id] = sign * base[i]; });
  return out;
}

export function computeShares(
  amountCents: number,
  splitType: SplitType,
  rule: SplitRule | null,
  roster: MemberId[],
): Shares {
  if (roster.length === 0) throw new RangeError('Cannot split across an empty roster');
  const known = new Set(roster);

  if (splitType === 'single') {
    const id = rule?.memberId;
    if (!id || !known.has(id)) throw new RangeError(`single split names an unknown member: ${id}`);
    return { [id]: amountCents };
  }

  if (splitType === 'custom') {
    const pct = rule?.percentages ?? {};
    for (const id of Object.keys(pct)) {
      if (!known.has(id)) throw new RangeError(`custom split names an unknown member: ${id}`);
    }
    return distributeByWeight(amountCents, pct);
  }

  return distributeByWeight(
    amountCents,
    Object.fromEntries(roster.map((id) => [id, 1])),
  );
}

export interface TxForBalance {
  payerId: MemberId;
  amountCents: number;
  shares: Shares;
}

export interface Transfer {
  from: MemberId;
  to: MemberId;
  amountCents: number;
}

export interface Settlement {
  balances: Record<MemberId, number>;
  transfers: Transfer[];
}

/** balance = total paid - total consumed. Positive means the member is owed money. */
export function computeBalances(txs: TxForBalance[], roster: MemberId[]): Record<MemberId, number> {
  const balances: Record<MemberId, number> = {};
  for (const id of roster) balances[id] = 0;

  for (const tx of txs) {
    const shareTotal = Object.values(tx.shares).reduce((a, b) => a + b, 0);
    if (shareTotal !== tx.amountCents) {
      throw new RangeError(
        `Share map sums to ${shareTotal} but the amount is ${tx.amountCents}`,
      );
    }
    balances[tx.payerId] = (balances[tx.payerId] ?? 0) + tx.amountCents;
    for (const [id, share] of Object.entries(tx.shares)) {
      balances[id] = (balances[id] ?? 0) - share;
    }
  }

  return balances;
}

/** Greedy creditor/debtor matching. Written generally, though the household has two people. */
export function minimalTransfers(balances: Record<MemberId, number>): Transfer[] {
  const total = Object.values(balances).reduce((a, b) => a + b, 0);
  if (total !== 0) throw new RangeError(`Balances sum to ${total}, expected 0`);

  const creditors = Object.entries(balances)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, v]) => ({ id, amount: v }));

  const debtors = Object.entries(balances)
    .filter(([, v]) => v < 0)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, v]) => ({ id, amount: -v }));

  const transfers: Transfer[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].amount, debtors[di].amount);
    transfers.push({ from: debtors[di].id, to: creditors[ci].id, amountCents: amount });
    creditors[ci].amount -= amount;
    debtors[di].amount -= amount;
    if (creditors[ci].amount === 0) ci++;
    if (debtors[di].amount === 0) di++;
  }

  return transfers;
}

export function computeSettlement(txs: TxForBalance[], roster: MemberId[]): Settlement {
  const balances = computeBalances(txs, roster);
  return { balances, transfers: minimalTransfers(balances) };
}

/**
 * Nets signed balances across unpaid cycles, then plans transfers once.
 * Settled cycles are always excluded; duplicate or unknown ids are ignored.
 * Contract: undefined selectedIds = every unpaid cycle; an empty list = none.
 */
export function combinedSettlement(
  cycles: { id: string; status: Cycle['status']; settlement: { balances: Record<MemberId, number> } }[],
  selectedIds?: Iterable<string>,
): Settlement & { cycleIds: string[] } {
  const wanted = selectedIds && new Set(selectedIds);
  const included = cycles.filter((c) => c.status !== 'settled' && (!wanted || wanted.has(c.id)));
  const balances: Record<MemberId, number> = {};
  for (const c of included) {
    for (const [id, v] of Object.entries(c.settlement.balances)) balances[id] = (balances[id] ?? 0) + v;
  }
  return { cycleIds: included.map((c) => c.id), balances, transfers: minimalTransfers(balances) };
}
