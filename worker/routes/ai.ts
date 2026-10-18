// Data access only through scope.repo, including the rate-limit counter.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireScope } from '../lib/scope';
import {
  parseReceipt, sniffImageMime, isAllowedMime, MAX_UPLOAD_BYTES,
  GeminiTimeoutError, GeminiQuotaError, GeminiUnsupportedFileError, GeminiUpstreamError,
} from '../lib/gemini';
import type { Env } from '../index';
import { CATEGORIES } from '../../src/constants';
import { findExplicitCategoryPreference } from '../../src/lib/category';

export const aiRoutes = new Hono<{ Bindings: Env }>();

aiRoutes.post('/parse-receipt', async (c) => {
  // The session check happens first: an unauthenticated caller triggers no
  // upstream request at all.
  const scope = await requireScope(c);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) throw new HTTPException(400, { message: 'Empty upload' });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: 'Receipt file must be 5 MB or smaller' });
  }

  const mime = sniffImageMime(bytes);
  if (!isAllowedMime(mime)) {
    throw new HTTPException(415, { message: 'Only JPEG, PNG, WebP, HEIC, and PDF files are accepted' });
  }

  const household = await scope.repo.household();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: household.timezone })
    .format(new Date());

  // Quota policy: checkAiQuota increments on this attempt, before the
  // upstream call, so a failed scan (timeout, upstream error, unsupported
  // file, etc.) still consumes the day's allowance same as a successful one.
  // Every attempt costs a real Gemini request whether or not it succeeds, and
  // a retry-on-failure loop that didn't count against quota would make the
  // limit meaningless. checkAiQuota only exposes an atomic check-and-increment
  // (worker/lib/ratelimit.ts, outside this route's ownership); refunding
  // quota on failure would need a separate decrement path there.
  const withinLimit = await scope.repo.checkAiQuota(today);
  if (!withinLimit) {
    throw new HTTPException(429, {
      message: 'Daily receipt scan limit reached. Enter this one manually.',
    });
  }

  let result;
  try {
    result = await parseReceipt(c.env.GEMINI_API_KEY, mime!, bytes, CATEGORIES);
  } catch (error) {
    if (error instanceof GeminiTimeoutError) {
      throw new HTTPException(504, {
        message: 'Receipt scan timed out. Please try again.',
      });
    }
    if (error instanceof GeminiQuotaError) {
      throw new HTTPException(429, {
        message: 'Receipt scanner is at capacity right now. Please try again shortly, or enter this one manually.',
      });
    }
    if (error instanceof GeminiUnsupportedFileError) {
      throw new HTTPException(422, {
        message: 'That file could not be read as a receipt. Try a clearer photo or a different format.',
      });
    }
    if (error instanceof GeminiUpstreamError) {
      console.error('Gemini upstream error', error.status);
      throw new HTTPException(503, {
        message: 'Receipt scanner is temporarily unavailable. Please try again.',
      });
    }
    console.error(error);
    throw new HTTPException(503, {
      message: 'Receipt scanner is temporarily unavailable. Please try again.',
    });
  }

  // Gemini supplies the default. Only an exact, explicitly saved user relabel
  // may override it; closed-cycle history and fuzzy merchant matches do not.
  const preferences = await scope.repo.categoryPreferences();
  result = {
    ...result,
    transactions: result.transactions.map((transaction) => ({
      ...transaction,
      category: transaction.store
        ? findExplicitCategoryPreference(transaction.store, preferences) ?? transaction.category
        : transaction.category,
    })),
  };

  // Returned rather than thrown so the body can carry a machine-readable
  // reason: the import result screen has to tell a reconciliation failure
  // apart from any other 422, and matching on message text is fragile.
  if (mime === 'application/pdf' && !result.reconciled) {
    if (result.statementTotalCents === null) {
      return c.json({
        error: 'Could not verify the statement total. No rows were imported.',
        reason: 'reconciliation_failed',
        itemsTotalCents: result.itemsTotalCents,
        statementTotalCents: null,
      }, 422);
    }
    const currency = household.currencyCode;
    const itemsTotal = (result.itemsTotalCents / 100).toFixed(2);
    const statementTotal = (result.statementTotalCents / 100).toFixed(2);
    return c.json({
      error: `Statement check failed: items total ${currency} ${itemsTotal}, statement total ${currency} ${statementTotal}. No rows were imported.`,
      reason: 'reconciliation_failed',
      itemsTotalCents: result.itemsTotalCents,
      statementTotalCents: result.statementTotalCents,
    }, 422);
  }

  const first = result.transactions[0]
    ?? { date: null, store: null, amountCents: null, category: null };
  // Top-level first draft keeps older cached clients working during deploys.
  return c.json({ ...first, ...result });
});
