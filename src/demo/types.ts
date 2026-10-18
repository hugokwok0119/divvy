import type { Bootstrap, ExpenseHistoryEvent, Transaction } from '../types';

/** One recorded statement parse from `sample-results.json` (Task 2). */
export interface SampleResult {
  id: string;
  fileName: string;
  layout: string;
  sha256: string;
  featured: boolean;
  description: string;
  status: 200 | 422;
  body: object;
}

/** The demo store: `bootstrap.transactions` holds open-cycle rows only; `archived` holds closed-cycle rows. */
export interface DemoState {
  bootstrap: Bootstrap;
  archived: Transaction[];
  history: ExpenseHistoryEvent[];
}
