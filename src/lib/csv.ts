import { parseAmountToCents } from './money';

export interface ParsedRow {
  date: string | null;
  store: string | null;
  amountCents: number | null;
  raw: string;
  issues: string[];
}

/** RFC 4180 style field splitter: handles quotes, embedded commas, and "" escapes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  if (ISO.test(v)) return v;
  const m = US.exec(v);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

function normalizeAmount(raw: string): number | null {
  let v = raw.trim();
  if (!v) return null;
  let negative = false;
  if (v.startsWith('(') && v.endsWith(')')) { negative = true; v = v.slice(1, -1); }
  try {
    const cents = parseAmountToCents(v);
    return negative ? -Math.abs(cents) : cents;
  } catch {
    return null;
  }
}

const DATE_HEADERS = ['date', 'transaction date', 'posted date'];
const STORE_HEADERS = ['description', 'store', 'merchant', 'payee', 'name'];
const AMOUNT_HEADERS = ['amount', 'debit', 'value', 'total'];

function findColumns(header: string[]): { date: number; store: number; amount: number } | null {
  const lower = header.map((h) => h.toLowerCase());
  const find = (names: string[]) => lower.findIndex((h) => names.includes(h));
  const date = find(DATE_HEADERS);
  const store = find(STORE_HEADERS);
  const amount = find(AMOUNT_HEADERS);
  if (date === -1 || store === -1 || amount === -1) return null;
  return { date, store, amount };
}

export function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];

  const first = splitLine(lines[0]);
  const cols = findColumns(first);

  let body: string[];
  let idx: { date: number; store: number; amount: number };

  if (cols) {
    body = lines.slice(1);
    idx = cols;
  } else {
    idx = { date: 0, store: 1, amount: 2 };
    // No recognised header. A line with neither a parseable date nor a
    // parseable amount carries no usable field, so it is a header we have no
    // alias for. A real row missing only its amount still has a date, and
    // survives to be flagged in `issues` rather than silently dropped.
    const looksLikeHeader =
      normalizeDate(first[idx.date] ?? '') === null &&
      normalizeAmount(first[idx.amount] ?? '') === null;
    body = looksLikeHeader ? lines.slice(1) : lines;
  }

  return body.map((line) => {
    const fields = splitLine(line);
    const date = normalizeDate(fields[idx.date] ?? '');
    const store = (fields[idx.store] ?? '').trim() || null;
    const amountCents = normalizeAmount(fields[idx.amount] ?? '');

    const issues: string[] = [];
    if (date === null) issues.push('date');
    if (store === null) issues.push('store');
    if (amountCents === null) issues.push('amount');

    return { date, store, amountCents, raw: line, issues };
  });
}
