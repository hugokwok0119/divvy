/**
 * Hand-written runtime validators for untrusted POST/PATCH bodies. No
 * validation library is a dependency (package.json has none), so this file
 * is the single source of truth for what "well-formed" means before a
 * request reaches scope.repo. Every exported `validate*` function returns
 * `{ value, fields }`: `fields` is empty when `value` is usable, and holds a
 * message per bad field (keyed by field name, `items[i].field` for a bulk
 * array) otherwise. Callers respond 400 with `{ error, fields }` and never
 * call the repo when `fields` is non-empty.
 */
import type { CloseCycleInput } from '../../src/types';
import type { SplitType, SplitRule } from '../../src/lib/settlement';

export type Fields = Record<string, string>;

import { MAX_AMOUNT_CENTS } from '../../src/lib/money';
export { MAX_AMOUNT_CENTS };
export const MAX_BULK_BATCH = 200;
export const ID_MAX_LEN = 100;
const STORE_MAX_LEN = 200;
export const CATEGORY_MAX_LEN = 40;
const NAME_MAX_LEN = 80;

export const SPLIT_TYPES = ['equal', 'custom', 'single'] as const;
export function expectedRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export const QUEUE_SOURCES = ['manual', 'csv', 'image'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not just a string shaped like one (rejects 2024-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isFiniteIntCents(value: unknown, max = MAX_AMOUNT_CENTS): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    && Math.abs(value) <= max;
}

/** Trims and enforces a length ceiling. Returns null for empty-after-trim or too long. */
export function trimmedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLen) return null;
  return trimmed;
}

export function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a splitType/splitRule pair against the household roster, closing
 * the gap where settlement.ts's computeShares throws a bare RangeError for
 * an unknown or missing member reference — uncaught, that becomes a generic
 * 500 instead of a 400. `splitType` is undefined on a PATCH that doesn't
 * touch the split; in that case any member ids splitRule still names are
 * checked, but no type-specific shape is enforced (the existing splitType
 * on the row decides that, and this file never reads the DB).
 *
 * ponytail: a PATCH that changes splitRule alone while leaving a stale
 * splitType='custom' row's shape mismatched (e.g. replacing percentages with
 * a bare memberId) is not caught here — closing it needs the row's current
 * splitType, which means a read this validator doesn't have. Fold in a
 * `currentSplitType` param if that edge case shows up in practice.
 */
export function splitRuleError(
  splitType: unknown,
  splitRule: unknown,
  roster: string[],
): string | null {
  if (splitType === 'single') {
    if (!isPlainObject(splitRule) || typeof splitRule.memberId !== 'string'
      || !roster.includes(splitRule.memberId)) {
      return 'single split requires splitRule.memberId naming a household member';
    }
    return null;
  }
  if (splitType === 'custom') {
    if (!isPlainObject(splitRule) || !isPlainObject(splitRule.percentages)) {
      return 'custom split requires splitRule.percentages';
    }
    const entries = Object.entries(splitRule.percentages);
    if (entries.length === 0) return 'custom split requires at least one member percentage';
    for (const [id, v] of entries) {
      if (!roster.includes(id)) return `Unknown member in splitRule.percentages: ${id}`;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `Invalid percentage for ${id}`;
    }
    return null;
  }
  // 'equal', or a PATCH not touching splitType: still verify any member ids
  // a supplied splitRule names are real, so a crafted reference can't reach
  // the database even though the shape isn't enforced here.
  if (isPlainObject(splitRule)) {
    if (typeof splitRule.memberId === 'string' && !roster.includes(splitRule.memberId)) {
      return `Unknown member in splitRule.memberId: ${splitRule.memberId}`;
    }
    if (isPlainObject(splitRule.percentages)) {
      for (const [id, v] of Object.entries(splitRule.percentages)) {
        if (!roster.includes(id)) return `Unknown member in splitRule.percentages: ${id}`;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `Invalid percentage for ${id}`;
      }
    }
  }
  return null;
}

export interface TxInputLike {
  id: string;
  date: string;
  store: string;
  amountCents: number;
  category: string;
  payerId: string;
  cardId: string | null;
  splitType: SplitType;
  splitRule: unknown;
  isStarred?: boolean;
  favoriteName?: string | null;
}

/** Full body of POST /api/transactions and the `transaction` half of queue confirm. */
export function validateTxInput(
  body: unknown,
  roster: string[],
): { value: TxInputLike | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };

  const id = trimmedString(body.id, ID_MAX_LEN);
  if (id === null) fields.id = 'Expected a non-empty string';

  if (!isIsoDate(body.date)) fields.date = 'Expected YYYY-MM-DD';

  const store = trimmedString(body.store, STORE_MAX_LEN);
  if (store === null) fields.store = 'Expected a non-empty string';

  if (!isFiniteIntCents(body.amountCents)) fields.amountCents = 'Expected an integer';

  const category = trimmedString(body.category, CATEGORY_MAX_LEN);
  if (category === null) fields.category = 'Expected a non-empty string';

  const payerId = trimmedString(body.payerId, ID_MAX_LEN);
  if (payerId === null) fields.payerId = 'Expected a non-empty string';

  if (body.cardId !== null && body.cardId !== undefined && typeof body.cardId !== 'string') {
    fields.cardId = 'Expected a string or null';
  }

  if (!isOneOf(body.splitType, SPLIT_TYPES)) {
    fields.splitType = `Expected one of ${SPLIT_TYPES.join(', ')}`;
  } else {
    const err = splitRuleError(body.splitType, body.splitRule, roster);
    if (err) fields.splitRule = err;
  }

  if (body.isStarred !== undefined && typeof body.isStarred !== 'boolean') {
    fields.isStarred = 'Expected a boolean';
  }
  if (body.favoriteName !== null && body.favoriteName !== undefined
    && trimmedString(body.favoriteName, NAME_MAX_LEN) === null) {
    fields.favoriteName = 'Expected a non-empty string or null';
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };

  return {
    value: {
      id: id!, date: body.date as string, store: store!, amountCents: body.amountCents as number,
      category: category!, payerId: payerId!,
      cardId: (body.cardId as string | null | undefined) ?? null,
      splitType: body.splitType as SplitType,
      splitRule: body.splitRule ?? null,
      isStarred: body.isStarred as boolean | undefined,
      favoriteName: body.favoriteName as string | null | undefined,
    },
    fields: {},
  };
}

/** Body of PATCH /api/transactions/:id — every field optional, but validated when present. */
export function validateTxPatch(
  body: unknown,
  roster: string[],
): { value: Record<string, unknown> | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };

  const value: Record<string, unknown> = {};

  if ('date' in body) {
    if (!isIsoDate(body.date)) fields.date = 'Expected YYYY-MM-DD';
    else value.date = body.date;
  }
  if ('store' in body) {
    const store = trimmedString(body.store, STORE_MAX_LEN);
    if (store === null) fields.store = 'Expected a non-empty string';
    else value.store = store;
  }
  if ('amountCents' in body) {
    if (!isFiniteIntCents(body.amountCents)) fields.amountCents = 'Expected an integer';
    else value.amountCents = body.amountCents;
  }
  if ('category' in body) {
    const category = trimmedString(body.category, CATEGORY_MAX_LEN);
    if (category === null) fields.category = 'Expected a non-empty string';
    else value.category = category;
  }
  if ('payerId' in body) {
    const payerId = trimmedString(body.payerId, ID_MAX_LEN);
    if (payerId === null) fields.payerId = 'Expected a non-empty string';
    else value.payerId = payerId;
  }
  if ('cardId' in body) {
    if (body.cardId !== null && typeof body.cardId !== 'string') {
      fields.cardId = 'Expected a string or null';
    } else value.cardId = body.cardId;
  }
  if ('splitType' in body && !isOneOf(body.splitType, SPLIT_TYPES)) {
    fields.splitType = `Expected one of ${SPLIT_TYPES.join(', ')}`;
  } else if ('splitType' in body) {
    value.splitType = body.splitType;
  }
  if ('splitType' in body || 'splitRule' in body) {
    const err = splitRuleError(body.splitType, body.splitRule, roster);
    if (err) fields.splitRule = err;
    else if ('splitRule' in body) value.splitRule = body.splitRule;
  }
  if ('isStarred' in body) {
    if (typeof body.isStarred !== 'boolean') fields.isStarred = 'Expected a boolean';
    else value.isStarred = body.isStarred;
  }
  if ('favoriteName' in body) {
    if (body.favoriteName !== null && trimmedString(body.favoriteName, NAME_MAX_LEN) === null) {
      fields.favoriteName = 'Expected a non-empty string or null';
    } else value.favoriteName = body.favoriteName;
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value, fields: {} };
}

export interface QueueInputLike {
  sourceFileId?: string | null;
  sourceFileName?: string | null;
  id: string;
  date: string | null;
  store: string | null;
  amountCents: number | null;
  category: string | null;
  payerId: string | null;
  cardId: string | null;
  splitType: string | null;
  splitRule?: SplitRule | null;
  isDuplicate?: boolean;
  source: 'manual' | 'csv' | 'image';
}

/** Body of POST /api/queue and each row of POST /api/queue/bulk. Most fields are nullable. */
export function validateQueueInput(body: unknown, roster?: string[]): { value: QueueInputLike | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };

  const id = trimmedString(body.id, ID_MAX_LEN);
  if (id === null) fields.id = 'Expected a non-empty string';

  if (body.date !== null && !isIsoDate(body.date)) fields.date = 'Expected YYYY-MM-DD or null';

  let store: string | null = null;
  if (body.store !== null) {
    store = trimmedString(body.store, STORE_MAX_LEN);
    if (store === null) fields.store = 'Expected a non-empty string or null';
  }

  if (body.amountCents !== null && !isFiniteIntCents(body.amountCents)) {
    fields.amountCents = 'Expected an integer or null';
  }

  let category: string | null = null;
  if (body.category !== null) {
    category = trimmedString(body.category, CATEGORY_MAX_LEN);
    if (category === null) fields.category = 'Expected a non-empty string or null';
  }

  if (body.payerId !== null && trimmedString(body.payerId, ID_MAX_LEN) === null) {
    fields.payerId = 'Expected a non-empty string or null';
  }
  if (body.cardId !== null && typeof body.cardId !== 'string') {
    fields.cardId = 'Expected a string or null';
  }
  if (body.splitType !== null && !isOneOf(body.splitType, SPLIT_TYPES)) {
    fields.splitType = `Expected one of ${SPLIT_TYPES.join(', ')}, or null`;
  }
  if (body.splitRule != null) {
    if (!isPlainObject(body.splitRule)) fields.splitRule = 'Expected a split rule object or null';
    else {
      const ids = [...Object.keys(isPlainObject(body.splitRule.percentages) ? body.splitRule.percentages : {}), ...(typeof body.splitRule.memberId === 'string' ? [body.splitRule.memberId] : [])];
      const error = splitRuleError(body.splitType, body.splitRule, roster ?? ids);
      if (error) fields.splitRule = error;
    }
  }
  if (body.isDuplicate !== undefined && typeof body.isDuplicate !== 'boolean') {
    fields.isDuplicate = 'Expected a boolean';
  }
  if (!isOneOf(body.source, QUEUE_SOURCES)) {
    fields.source = `Expected one of ${QUEUE_SOURCES.join(', ')}`;
  }

  const hasFileId = body.sourceFileId != null;
  const hasFileName = body.sourceFileName != null;
  const sourceFileId = hasFileId ? trimmedString(body.sourceFileId, ID_MAX_LEN) : null;
  if (hasFileId && sourceFileId === null) fields.sourceFileId = `Expected a non-empty string of at most ${ID_MAX_LEN} characters`;
  if (hasFileName && (typeof body.sourceFileName !== 'string'
    || body.sourceFileName.trim() === '' || body.sourceFileName.length > 255)) {
    fields.sourceFileName = 'Expected a non-empty string of at most 255 characters';
  }
  if (hasFileId !== hasFileName) {
    fields[hasFileId ? 'sourceFileName' : 'sourceFileId'] = 'File ID and filename must be supplied together';
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };

  return {
    value: {
      id: id!,
      sourceFileId,
      sourceFileName: hasFileName ? body.sourceFileName as string : null,
      date: (body.date as string | null) ?? null,
      store,
      amountCents: (body.amountCents as number | null) ?? null,
      category,
      payerId: (body.payerId as string | null) ?? null,
      cardId: (body.cardId as string | null) ?? null,
      splitType: (body.splitType as string | null) ?? null,
      splitRule: (body.splitRule as SplitRule | null | undefined) ?? null,
      isDuplicate: body.isDuplicate as boolean | undefined,
      source: body.source as 'manual' | 'csv' | 'image',
    },
    fields: {},
  };
}

/** Body of PATCH /api/queue/:id — every field optional, but validated when present. */
export function validateQueuePatch(body: unknown, roster?: string[]): { value: Record<string, unknown> | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const value: Record<string, unknown> = {};

  if ('date' in body) {
    if (body.date !== null && !isIsoDate(body.date)) fields.date = 'Expected YYYY-MM-DD or null';
    else value.date = body.date;
  }
  if ('store' in body) {
    if (body.store === null) value.store = null;
    else {
      const store = trimmedString(body.store, STORE_MAX_LEN);
      if (store === null) fields.store = 'Expected a non-empty string or null';
      else value.store = store;
    }
  }
  if ('amountCents' in body) {
    if (body.amountCents !== null && !isFiniteIntCents(body.amountCents)) {
      fields.amountCents = 'Expected an integer or null';
    } else value.amountCents = body.amountCents;
  }
  if ('category' in body) {
    if (body.category === null) value.category = null;
    else {
      const category = trimmedString(body.category, CATEGORY_MAX_LEN);
      if (category === null) fields.category = 'Expected a non-empty string or null';
      else value.category = category;
    }
  }
  if ('payerId' in body) {
    if (body.payerId !== null && trimmedString(body.payerId, ID_MAX_LEN) === null) {
      fields.payerId = 'Expected a non-empty string or null';
    } else value.payerId = body.payerId;
  }
  if ('cardId' in body) {
    if (body.cardId !== null && typeof body.cardId !== 'string') {
      fields.cardId = 'Expected a string or null';
    } else value.cardId = body.cardId;
  }
  if ('splitType' in body) {
    if (body.splitType !== null && !isOneOf(body.splitType, SPLIT_TYPES)) {
      fields.splitType = `Expected one of ${SPLIT_TYPES.join(', ')}, or null`;
    } else value.splitType = body.splitType;
  }
  if ('splitRule' in body) {
    if (body.splitRule !== null && !isPlainObject(body.splitRule)) fields.splitRule = 'Expected a split rule object or null';
    else {
      const rule = isPlainObject(body.splitRule) ? body.splitRule : {};
      const ids = [...Object.keys(isPlainObject(rule.percentages) ? rule.percentages : {}), ...(typeof rule.memberId === 'string' ? [rule.memberId] : [])];
      const error = splitRuleError(body.splitType, body.splitRule, roster ?? ids);
      if (error) fields.splitRule = error;
      else value.splitRule = body.splitRule;
    }
  }
  if ('isDuplicate' in body) {
    if (typeof body.isDuplicate !== 'boolean') fields.isDuplicate = 'Expected a boolean';
    else value.isDuplicate = body.isDuplicate;
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value, fields: {} };
}

/** Body of POST /api/queue/bulk. Duplicate ids within the array are caught here, before any DB access. */
export function validateQueueBulk(body: unknown, roster?: string[]): { items: QueueInputLike[] | null; fields: Fields } {
  if (!isPlainObject(body)) {
    return { items: null, fields: { _body: 'Expected a JSON object with an items array' } };
  }
  const { items } = body;
  if (!Array.isArray(items)) return { items: null, fields: { items: 'Expected an array' } };
  if (items.length === 0) return { items: null, fields: { items: 'Must not be empty' } };
  if (items.length > MAX_BULK_BATCH) {
    return { items: null, fields: { items: `Exceeds maximum batch size of ${MAX_BULK_BATCH}` } };
  }

  const fields: Fields = {};
  const parsed: QueueInputLike[] = [];
  items.forEach((raw, i) => {
    const { value, fields: itemFields } = validateQueueInput(raw, roster);
    if (value === null) {
      for (const [k, v] of Object.entries(itemFields)) fields[`items[${i}].${k}`] = v;
    } else {
      parsed.push(value);
    }
  });
  if (Object.keys(fields).length > 0) return { items: null, fields };

  const ids = parsed.map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    return { items: null, fields: { items: 'Duplicate id within the same upload' } };
  }

  return { items: parsed, fields: {} };
}

/** Body of POST /api/cycles/close. */
export function validateCloseCycle(
  body: unknown,
): { value: CloseCycleInput | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };

  const cycleId = trimmedString(body.cycleId, ID_MAX_LEN);
  if (cycleId === null) fields.cycleId = 'Expected a non-empty string';

  const transactionIds = body.transactionIds;
  if (!Array.isArray(transactionIds) || transactionIds.some((t) => typeof t !== 'string' || t.trim() === '')) {
    fields.transactionIds = 'Expected a non-empty array of strings';
  } else if (transactionIds.length === 0) {
    fields.transactionIds = 'Expected at least one transaction id';
  }

  if (Array.isArray(transactionIds) && new Set(transactionIds).size !== transactionIds.length) {
    fields.transactionIds = 'Duplicate transaction id';
  }
  if (body.confirmed !== true) fields.confirmed = 'Explicit closing confirmation is required';
  const revisions = body.revisions;
  if (!isPlainObject(revisions) || !Array.isArray(transactionIds)
    || Object.keys(revisions).length !== transactionIds.length
    || transactionIds.some((id) => typeof id !== 'string' || !Object.hasOwn(revisions, id) || !expectedRevision(revisions[id]))) {
    fields.revisions = 'Expected the current revision for exactly each selected transaction';
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value: { cycleId: cycleId!, transactionIds: transactionIds as string[], confirmed: true,
    revisions: revisions as Record<string, number> }, fields: {} };
}

/** Body of POST /api/queue/:id/confirm. */
export function validateConfirmBody(
  body: unknown,
): { value: { transactionId: string; transaction: unknown } | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };

  const transactionId = trimmedString(body.transactionId, ID_MAX_LEN);
  if (transactionId === null) fields.transactionId = 'Expected a non-empty string';
  if (!isPlainObject(body.transaction)) fields.transaction = 'Expected an object';

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value: { transactionId: transactionId!, transaction: body.transaction }, fields: {} };
}

function sortOrderError(body: Record<string, unknown>): string | null {
  if (!('sortOrder' in body) || body.sortOrder === undefined) return null;
  return typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
    ? null : 'Expected a number';
}

/** Body of POST /api/members (`id` required) and PATCH /api/members/:id (`id` comes from the URL). */
export function validateMemberInput(
  body: unknown,
  { requireId }: { requireId: boolean },
): { value: Record<string, unknown> | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const value: Record<string, unknown> = { ...body };

  if (requireId || 'id' in body) {
    const id = trimmedString(body.id, ID_MAX_LEN);
    if (id === null) fields.id = 'Expected a non-empty string';
    else value.id = id;
  }
  if (requireId || 'displayName' in body) {
    const name = trimmedString(body.displayName, NAME_MAX_LEN);
    if (name === null) fields.displayName = 'Expected a non-empty string';
    else value.displayName = name;
  }
  const sortErr = sortOrderError(body);
  if (sortErr) fields.sortOrder = sortErr;

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value, fields: {} };
}

/** Body of POST /api/cards (`id`/`memberId`/`name` required) and PATCH /api/cards/:id. */
export function validateCardInput(
  body: unknown,
  { requireId }: { requireId: boolean },
): { value: Record<string, unknown> | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const value: Record<string, unknown> = { ...body };

  if (requireId || 'id' in body) {
    const id = trimmedString(body.id, ID_MAX_LEN);
    if (id === null) fields.id = 'Expected a non-empty string';
    else value.id = id;
  }
  if (requireId || 'memberId' in body) {
    const memberId = trimmedString(body.memberId, ID_MAX_LEN);
    if (memberId === null) fields.memberId = 'Expected a non-empty string';
    else value.memberId = memberId;
  }
  if (requireId || 'name' in body) {
    const name = trimmedString(body.name, NAME_MAX_LEN);
    if (name === null) fields.name = 'Expected a non-empty string';
    else value.name = name;
  }
  const sortErr = sortOrderError(body);
  if (sortErr) fields.sortOrder = sortErr;
  const day = body.statementDay;
  if (day !== undefined && day !== null && !(Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 31)) {
    fields.statementDay = 'Expected a whole day from 1 to 31, or null';
  }
  if ('applyToHistory' in body && typeof body.applyToHistory !== 'boolean') {
    fields.applyToHistory = 'Expected a boolean';
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value, fields: {} };
}

/** Body of PATCH /api/household. */
export function validateHouseholdPatch(body: unknown): { value: Record<string, unknown> | null; fields: Fields } {
  const fields: Fields = {};
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const value: Record<string, unknown> = {};

  if ('name' in body) {
    const name = trimmedString(body.name, NAME_MAX_LEN);
    if (name === null) fields.name = 'Expected a non-empty string';
    else value.name = name;
  }
  if ('customCategories' in body) {
    const cats = body.customCategories;
    if (!Array.isArray(cats) || cats.some((c) => trimmedString(c, CATEGORY_MAX_LEN) === null)) {
      fields.customCategories = 'Expected an array of non-empty strings';
    } else value.customCategories = cats.map((c) => (c as string).trim());
  }
  if ('allowedEmails' in body) {
    const list = body.allowedEmails;
    const validEntry = (e: unknown) => isPlainObject(e)
      && typeof e.email === 'string' && e.email.trim() !== ''
      && typeof e.memberId === 'string' && e.memberId.trim() !== '';
    if (!Array.isArray(list) || !list.every(validEntry)) {
      fields.allowedEmails = 'Expected an array of { email, memberId }';
    } else value.allowedEmails = list;
  }

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value, fields: {} };
}

/** Body of POST /api/groups. */
export function validateGroupInput(body: unknown): { value: { name: string; currencyCode: string; timezone: string } | null; fields: Fields } {
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const fields: Fields = {};
  const name = trimmedString(body.name, NAME_MAX_LEN);
  if (name === null) fields.name = 'Expected a non-empty string';
  const { currencyCode, timezone } = body;
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) fields.currencyCode = 'Expected a three-letter code such as CAD';
  if (!isTimeZone(timezone)) fields.timezone = 'Expected a time zone such as America/Vancouver';

  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value: { name: name!, currencyCode: currencyCode as string, timezone: timezone as string }, fields: {} };
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `{ name }` where null resets a cycle to its default label. */
export function validateCycleName(body: unknown): { value: { name: string | null } | null; fields: Fields } {
  if (!isPlainObject(body) || !('name' in body)) return { value: null, fields: { name: 'Expected a name or null' } };
  if (body.name === null) return { value: { name: null }, fields: {} };
  const name = trimmedString(body.name, NAME_MAX_LEN);
  if (name === null) return { value: null, fields: { name: `Expected 1 to ${NAME_MAX_LEN} characters, or null` } };
  return { value: { name }, fields: {} };
}

export const REMINDER_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Body of PUT /api/reminders: one manual tick or untick for a month's reminder. */
export function validateReminderInput(body: unknown): { value: { month: string; reminderId: string; done: boolean } | null; fields: Fields } {
  if (!isPlainObject(body)) return { value: null, fields: { _body: 'Expected a JSON object' } };
  const fields: Fields = {};
  const { month, reminderId, done } = body;
  if (typeof month !== 'string' || !REMINDER_MONTH.test(month)) fields.month = 'Expected YYYY-MM';
  const cardId = typeof reminderId === 'string' && reminderId.startsWith('card:') ? reminderId.slice(5) : null;
  if (reminderId !== 'rent' && !(cardId && cardId.length <= ID_MAX_LEN)) fields.reminderId = 'Expected rent or card:<cardId>';
  if (typeof done !== 'boolean') fields.done = 'Expected a boolean';
  if (Object.keys(fields).length > 0) return { value: null, fields };
  return { value: { month: month as string, reminderId: reminderId as string, done: done as boolean }, fields: {} };
}

/** Body of PUT /api/cards/order and /api/members/order: distinct ids, first shown first. */
export function validateOrderInput(body: unknown): { ids: string[] | null; fields: Fields } {
  const ids = isPlainObject(body) ? body.ids : undefined;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_BATCH
    || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= ID_MAX_LEN)
    || new Set(ids).size !== ids.length) {
    return { ids: null, fields: { ids: `Expected 1-${MAX_BULK_BATCH} distinct ids` } };
  }
  return { ids, fields: {} };
}
