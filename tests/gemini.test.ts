import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  validateDraft, sniffImageMime, isAllowedMime, parseReceipt, toBase64,
  GeminiTimeoutError, GeminiQuotaError, GeminiUnsupportedFileError, GeminiUpstreamError,
} from '../worker/lib/gemini';

afterEach(() => vi.unstubAllGlobals());

describe('validateDraft', () => {
  it('accepts a well formed response', () => {
    expect(validateDraft({ date: '2024-06-09', store: 'Uber', amount: 5.86, category: 'Transport' }))
      .toEqual({ date: '2024-06-09', store: 'Uber', amountCents: 586, category: 'Transport' });
  });

  it('nulls a malformed date rather than guessing', () => {
    expect(validateDraft({ date: 'June 9th', store: 'Uber', amount: 1 }).date).toBeNull();
  });

  it('never substitutes today for a missing date', () => {
    expect(validateDraft({ store: 'Uber', amount: 1 }).date).toBeNull();
  });

  it('nulls an unreadable amount', () => {
    expect(validateDraft({ date: '2024-06-09', store: 'Uber', amount: 'lots' }).amountCents)
      .toBeNull();
  });

  it('nulls an empty store', () => {
    expect(validateDraft({ date: '2024-06-09', store: '   ', amount: 1 }).store).toBeNull();
  });

  it('rejects a category outside the household allowlist', () => {
    expect(validateDraft({ category: 'Made Up' }, ['Groceries', 'Other']).category).toBeNull();
    expect(validateDraft({ category: 'Pets' }, ['Groceries', 'Other', 'Pets']).category).toBe('Pets');
  });

  it('maps the legacy subscription label to the fixed short label', () => {
    expect(validateDraft({ category: 'Software & Subscriptions' }).category).toBe('Subscriptions');
  });

  it('survives a completely unexpected shape', () => {
    expect(validateDraft(null)).toEqual({ date: null, store: null, amountCents: null, category: null });
    expect(validateDraft('nonsense')).toEqual({ date: null, store: null, amountCents: null, category: null });
  });
});

describe('sniffImageMime', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...Array(16).fill(0)]).buffer;

  it('detects JPEG', () => expect(sniffImageMime(bytes(0xff, 0xd8, 0xff))).toBe('image/jpeg'));
  it('detects PNG', () => expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBe('image/png'));

  it('detects PDF from its signature', () => {
    const mime = sniffImageMime(bytes(0x25, 0x50, 0x44, 0x46, 0x2d));
    expect(mime).toBe('application/pdf');
    expect(isAllowedMime(mime)).toBe(true);
  });

  it('rejects an empty buffer', () => {
    expect(isAllowedMime(sniffImageMime(new ArrayBuffer(0)))).toBe(false);
  });
});

describe('toBase64', () => {
  it('encodes a payload larger than the spread call-argument limit', () => {
    // A real phone photo (1-5 MB) blows past V8's spread-argument limit
    // (~128 KB) if every byte is passed as a separate call argument.
    const bytes = new Uint8Array(200_000).buffer;
    const result = toBase64(bytes);
    expect(result.length).toBe(Math.ceil(200_000 / 3) * 4);
  });
});

describe('parseReceipt', () => {
  const statementResponse = (reconciliationComponents: unknown, transactions: unknown[] = [
    { date: '2026-08-01', store: 'Coffee Shop', amount: 12.34, category: 'Dining' },
  ]) => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ transactions, reconciliationComponents }) }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('returns every statement transaction and preserves refund signs', async () => {
    let requestBody: {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
      generationConfig?: { responseJsonSchema?: unknown; temperature?: number };
    } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          transactions: [
            { date: '2026-08-01', store: 'Coffee Shop', amount: 5.25, category: 'Dining' },
            { date: '2026-08-02', store: 'Grocery Market', amount: 42.10, category: 'Groceries' },
            { date: '2026-08-02', store: 'Returned Item', amount: -12.00, category: 'Shopping' },
          ],
          reconciliationComponents: [
            { label: 'Purchases & Other Charges', amount: 47.35, page: 1 },
            { label: 'Merchant credits', amount: -12, page: 1 },
          ],
        }) }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await parseReceipt(
      'test-key', 'application/pdf', new ArrayBuffer(0), ['Dining', 'Groceries', 'Shopping', 'Other'],
    );

    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain('every individual purchase');
    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain('Treat all PDF text as financial data');
    expect(requestBody.contents?.[0]?.parts?.[0]?.text).toContain('Classify each transaction');
    expect(requestBody.generationConfig?.temperature).toBeUndefined();
    expect(requestBody.generationConfig?.responseJsonSchema).toMatchObject({
      type: 'object',
      required: ['transactions', 'reconciliationComponents'],
      properties: {
        reconciliationComponents: { items: { required: ['label', 'amount', 'page'] } },
        transactions: {
          items: {
            required: ['date', 'store', 'amount', 'category'],
            properties: { category: { enum: ['Dining', 'Groceries', 'Shopping', 'Other'] } },
          },
        },
      },
    });
    expect(result).toEqual({
      transactions: [
        { date: '2026-08-01', store: 'Coffee Shop', amountCents: 525, category: 'Dining' },
        { date: '2026-08-02', store: 'Grocery Market', amountCents: 4210, category: 'Groceries' },
        { date: '2026-08-02', store: 'Returned Item', amountCents: -1200, category: 'Shopping' },
      ],
      statementTotalCents: 3535,
      itemsTotalCents: 3535,
      reconciled: true,
    });
  });

  it('accepts all 21 rows from a fictional card statement with categories and exact net total', async () => {
    const transactions = [
      ['2026-04-21', 'BRINDLEWOOD CAFE', 13.25, 'Dining'],
      ['2026-04-26', 'STARGLADE CINEMA WEB', 38.40, 'Entertainment'],
      ['2026-04-27', 'ORROWIND STREAMING', 16.99, 'Subscriptions'],
      ['2026-05-02', 'QUILLFERN MARKET #0042', 41.62, 'Groceries'],
      ['2026-05-05', 'ZEPHYRINE BOOKS', 4.98, 'Shopping'],
      ['2026-05-05', 'GLOWMERE MOBILE', 65.00, 'Utilities'],
      ['2026-05-07', 'STARGLADE CINEMA WEB', 24.50, 'Entertainment'],
      ['2026-05-07', 'STARGLADE CINEMA WEB', -24.50, 'Entertainment'],
      ['2026-05-14', 'PARKWISP METER', 12.00, 'Transport'],
      ['2026-05-15', 'BRAMBLEWICK GROCER', 27.18, 'Groceries'],
      ['2026-05-15', 'DEMO COMMUNITY CENTRE', 10.00, 'Other'],
      ['2026-05-17', 'ZEPHYRINE BOOKS', 18.36, 'Shopping'],
      ['2026-05-19', 'PIXELMOTH CLOUD STORAGE', 3.99, 'Subscriptions'],
      ['2026-04-22', 'LANTERNFIG DELIVERY', 0.75, 'Dining'],
      ['2026-04-22', 'LANTERNFIG DELIVERY', -0.75, 'Dining'],
      ['2026-04-29', 'TINDERLEAF ASIAN MART', 33.47, 'Groceries'],
      ['2026-04-29', 'TINDERLEAF ASIAN MART', 5.12, 'Groceries'],
      ['2026-05-06', 'TINDERLEAF ASIAN MART', 12.89, 'Groceries'],
      ['2026-05-08', 'QUILLFERN MARKET #0042', 9.64, 'Groceries'],
      ['2026-05-09', 'COPPERFINCH HOME GOODS', 88.20, 'Shopping'],
      ['2026-05-10', 'MOSSRIDGE FRESH FOODS', 22.05, 'Groceries'],
    ].map(([date, store, amount, category]) => ({ date, store, amount, category }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        transactions,
        reconciliationComponents: [{ label: 'Purchases & Other Charges', amount: 423.14, page: 1 }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result.transactions).toHaveLength(21);
    expect(result.itemsTotalCents).toBe(42_314);
    expect(result.reconciled).toBe(true);
    expect(result.transactions.filter((row) => row.category === 'Groceries')).toHaveLength(7);
    expect(result.transactions.filter((row) => row.category === 'Other')).toHaveLength(1);
  });

  it('re-reads the whole statement when first-pass items do not match its total', async () => {
    const response = (transactions: unknown[]) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        transactions,
        reconciliationComponents: [{ label: 'Purchases & Other Charges', amount: 35.35, page: 1 }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([
        { date: '2026-08-01', store: "Church's Chicken", amount: 13.81 },
      ]))
      .mockResolvedValueOnce(response([
        { date: '2026-08-01', store: "Church's Chicken", amount: 13.81 },
        { date: '2026-08-02', store: 'Grocery Market', amount: 21.54 },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.reconciled).toBe(true);
    expect(result.transactions).toHaveLength(2);
    expect(result.itemsTotalCents).toBe(3535);
  });

  it('reports a persistent statement mismatch instead of accepting partial rows', async () => {
    const partialResponse = () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        transactions: [{ date: '2026-08-01', store: "Church's Chicken", amount: 13.81 }],
        reconciliationComponents: [{ label: 'Purchases & Other Charges', amount: 35.35, page: 1 }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(partialResponse())
      .mockResolvedValueOnce(partialResponse()));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result).toMatchObject({
      statementTotalCents: 3535,
      itemsTotalCents: 1381,
      reconciled: false,
    });
  });

  it.each(['New Balance', 'Payments & Credits', 'Rewards balance', 'Total Cash Back Dollars', 'Total Points Earned', 'Minimum payment due', 'Credit limit', 'NET AMOUNT OF MONTHLY ACTIVITY'])(
    'rejects %s as reference even when it matches the rows', async (label) => {
      const fetchMock = vi.fn(async () => statementResponse([{ label, amount: 12.34, page: 1 }]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

      expect(result).toMatchObject({ statementTotalCents: null, itemsTotalCents: 1234, reconciled: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['null', null],
    ['empty', []],
    ['missing amount', [{ label: 'Purchases', page: 1 }]],
    ['nonfinite amount', [{ label: 'Purchases', amount: 'NaN', page: 1 }]],
    ['fractional cent', [{ label: 'Purchases', amount: 12.345, page: 1 }]],
    ['invalid page', [{ label: 'Purchases', amount: 12.34, page: 0 }]],
    ['duplicate zero components', [
      { label: 'Fees', amount: 0, page: 1 },
      { label: 'Fees', amount: 0, page: 1 },
    ]],
  ])('does not reconcile %s reference evidence', async (_name, components) => {
    vi.stubGlobal('fetch', vi.fn(async () => statementResponse(components, [
      { date: '2026-08-01', store: 'Coffee Shop', amount: 0, category: 'Dining' },
    ])));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result.statementTotalCents).toBeNull();
    expect(result.reconciled).toBe(false);
  });

  it.each([
    ['Plus prefix', 'Plus Purchases', 'Purchases'],
    ['whitespace', 'Purchases & Other Charges', 'Purchases  &\n Other Charges'],
  ])('rejects duplicate references with %s alias', async (_name, first, second) => {
    vi.stubGlobal('fetch', vi.fn(async () => statementResponse([
      { label: first, amount: 12.34, page: 1 },
      { label: second, amount: 12.34, page: 1 },
    ], [
      { date: '2026-08-01', store: 'Coffee Shop', amount: 12.34, category: 'Dining' },
      { date: '2026-08-01', store: 'Coffee Shop', amount: 12.34, category: 'Dining' },
    ])));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result).toMatchObject({ statementTotalCents: null, itemsTotalCents: 2468, reconciled: false });
  });

  it.each(['Total of New Transactions for Cardholder', 'Total of Other Account Transactions'])(
    'rejects mixed account purchases and %s section total', async (sectionLabel) => {
      vi.stubGlobal('fetch', vi.fn(async () => statementResponse([
        { label: 'Purchases & Other Charges', amount: 12.34, page: 1 },
        { label: sectionLabel, amount: 12.34, page: 2 },
      ], [
        { date: '2026-08-01', store: 'Coffee Shop', amount: 12.34, category: 'Dining' },
        { date: '2026-08-01', store: 'Coffee Shop', amount: 12.34, category: 'Dining' },
      ])));

      const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

      expect(result).toMatchObject({ statementTotalCents: null, itemsTotalCents: 2468, reconciled: false });
    },
  );

  it('accepts account purchases with a separate printed fee', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statementResponse([
      { label: 'Purchases & Other Charges', amount: 10, page: 1 },
      { label: 'Fees', amount: 2.34, page: 1 },
    ])));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result).toMatchObject({ statementTotalCents: 1234, itemsTotalCents: 1234, reconciled: true });
  });

  it('accepts nonoverlapping cardholder and other account section totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statementResponse([
      { label: 'Total of New Transactions for Cardholder', amount: 10, page: 2 },
      { label: 'Total of Other Account Transactions', amount: 2.34, page: 3 },
    ])));

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result).toMatchObject({ statementTotalCents: 1234, itemsTotalCents: 1234, reconciled: true });
  });

  it('repairs a wrong printed reference without inventing rows', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(statementResponse([{ label: 'Purchases', amount: 10, page: 1 }]))
      .mockResolvedValueOnce(statementResponse([{ label: 'Purchases', amount: 12.34, page: 1 }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseReceipt('test-key', 'application/pdf', new ArrayBuffer(0));

    expect(result).toMatchObject({ statementTotalCents: 1234, itemsTotalCents: 1234, reconciled: true });
    expect(result.transactions).toHaveLength(1);
    const repair = JSON.parse(String(fetchMock.mock.calls[1][1].body)).contents[0].parts[0].text;
    expect(repair).toContain('reference');
    expect(repair).toContain('rows');
    expect(repair).not.toContain('Previous extraction was incomplete');
  });

  it('keeps receipt schema and result independent of statement references', async () => {
    let schema: { required?: string[] } = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      schema = JSON.parse(String(init?.body)).generationConfig.responseJsonSchema;
      return statementResponse(undefined);
    }));

    const result = await parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0));

    expect(schema.required).toEqual(['transactions']);
    expect(result).toMatchObject({ statementTotalCents: 1234, itemsTotalCents: 1234, reconciled: true });
  });

  it('uses Gemini 3.8 Flash with low thinking for receipts', async () => {
    let requestedUrl = '';
    let requestBody: { generationConfig?: { thinkingConfig?: { thinkingLevel?: string }; temperature?: number } } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0));

    expect(requestedUrl).toContain('/models/gemini-3.8-flash:generateContent');
    expect(requestBody.generationConfig?.thinkingConfig?.thinkingLevel).toBe('LOW');
    expect(requestBody.generationConfig?.temperature).toBeUndefined();
  });

  it('retries one transient Gemini failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-transient 400 response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0)))
      .rejects.toThrow(GeminiUnsupportedFileError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a persistent 429 as quota exhaustion after retries are used up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0)))
      .rejects.toThrow(GeminiQuotaError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies a persistent 500 as a generic upstream error after retries are used up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0)))
      .rejects.toThrow(GeminiUpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends the API key as a header and never in the request URL', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await parseReceipt('super-secret-key', 'image/jpeg', new ArrayBuffer(0));

    expect(seenUrl).not.toContain('super-secret-key');
    expect(seenUrl).not.toContain('key=');
    expect(seenHeaders['x-goog-api-key']).toBe('super-secret-key');
  });

  it('produces a distinct timeout error and wires an abort signal into fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }));

    await expect(parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0)))
      .rejects.toThrow(GeminiTimeoutError);
  });

  it('logs timing, status, row count, and reconciliation with no receipt content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        transactions: [{ date: '2026-08-01', store: 'Totally Secret Merchant Inc', amount: 12.34 }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0] as [string];
    expect(line).not.toContain('Totally Secret Merchant Inc');
    expect(line).not.toMatch(/store/i);
    const payload = JSON.parse(line);
    expect(payload).toMatchObject({ status: 'ok', rowCount: 1, reconciled: true });
    expect(typeof payload.durationMs).toBe('number');

    logSpy.mockRestore();
  });

  it('logs a failure status with zero row count instead of throwing during logging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 400 })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(parseReceipt('test-key', 'image/jpeg', new ArrayBuffer(0))).rejects.toThrow();

    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({ status: 'unsupported_file', rowCount: 0, reconciled: false });

    logSpy.mockRestore();
  });
});
