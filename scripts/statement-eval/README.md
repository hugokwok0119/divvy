# Statement extraction evaluation

This standalone Python 3 harness evaluates the proposed Gemini statement prompt and schema. It does not change the app. The direct runner uses `gemini-3.8-flash` with LOW thinking and `x-goog-api-key`; its optional baseline uses the prior `gemini-3.6-flash` prompt/settings. The exact proposal is also in `proposed-prompt.txt` and `proposed-schema.json` for review. The optional baseline snapshots the statement prompt and request settings from `git HEAD` before this experiment.

## Mock statement set

`mock-statements/` holds 13 fictional credit-card statements (301 rows) and their ground truth. Every merchant, amount, date and account detail is invented, and every page carries the notice "FICTIONAL SAMPLE: all data is made up, for demo and testing only. Not a real statement." No card issuer, card network, person, phone number or address appears. Account numbers are masked as `XXXX ... 0000`.

The PDFs use six layouts that imitate common statement structures without any issuer's name or design. Each layout has at least one development and one test statement.

- **Layout A** prints an account summary first (`Plus Purchases`, `Plus Fees`, `Equals New Balance`), then payments, a section per cardholder with a `Total of New Transactions for` subtotal, a fee section, an explanatory page and a rewards table that repeats dining and grocery purchases.
- **Layout B** prints card activity beside a balance panel (`Purchases & Other Charges`, `Fees`, `NEW BALANCE`), puts a page of terms in the middle, and continues the activity on page 3. Its `NET AMOUNT OF MONTHLY ACTIVITY` includes the card payment, so it is not valid reference evidence.
- **Layout C** follows the US periodic statement model: a Summary of Account Activity where `Purchases` is gross and refunds are a separate negative `Other Credits` line, transactions grouped by type with reference numbers and `MM/DD` dates, foreign-currency rows with the original amount and rate on a second line plus a separate foreign transaction fee row, `TOTAL FEES FOR THIS PERIOD`, and year-to-date fee totals that must not be used.
- **Layout D** prints the post date before the transaction date, marks credits with a `CR` suffix, omits thousands separators, groups rows under cardholder blocks, and prints only gross `Purchases & Debits` and a `Payments & Credits` line that mixes the payment with refunds. No printed figure isolates the included rows, so the correct reference is `null`.
- **Layout E** is an online transaction-history printout: newest first, `DD/MM/YYYY` dates, separate Debit and Credit columns and a running balance, with no summary. The correct reference is `null`.
- **Layout F** groups transactions by spending category with a subtotal per category and a points column, and repeats the category totals in a spending table on page 1.

| Case | Split | Layout | Rows | Traps |
|------|-------|--------|------|-------|
| `sample-a1` | development | A | 30 | Overpayment leaves a credit balance of -$490.95 against $3,009.05 of included rows; a large purchase with a partial refund and a grocery refund; two rows dated before the period opens; a cardholder section continues on page 3 |
| `sample-b1` | development | B | 16 | Closing balance equals the included total by coincidence; the same charge at the same store on consecutive days |
| `sample-a2` | test | A | 41 | The primary cardholder section continues onto page 3; two refunds; closing balance equals the included total by coincidence |
| `sample-a3` | test | A | 30 | An identical charge repeated on the same day; partial payment, so the closing balance differs from the included total; two rows dated before the period opens; a cardholder section continues on page 3 |
| `sample-b2` | test | B | 21 | An annual fee reported separately as `Fees`; partial payment, so the closing balance differs from the included total |
| `sample-c1` | development | C | 21 | Two USD rows, each with its own foreign transaction fee row; a refund equal to an earlier purchase and a second, smaller refund; closing balance equals the included total by coincidence |
| `sample-c2` | test | C | 21 | A EUR purchase and a EUR refund at different rates; an annual membership fee; year-to-date fees larger than this period's; partial payment |
| `sample-d1` | development | D | 18 | Period crosses a year end, so December rows belong to the earlier year; a merchant credit equal to the purchase; no clean printed reference |
| `sample-d2` | test | D | 19 | A purchase converted to instalments (purchase, equal `CR` credit, `1ST OF 6 INSTALMENTS` row) and an instalment plan table; partial payment; no clean printed reference |
| `sample-e1` | development | E | 17 | Newest first; a refund in the Credit column; ambiguous day-first dates; no summary |
| `sample-e2` | test | E | 20 | An identical charge repeated on the same day; a refund; partial payment; no summary |
| `sample-f1` | development | F | 23 | Category subtotals and a spending table that repeat each other; an annual fee in its own group; a refund inside a category |
| `sample-f2` | test | F | 24 | No fees, so the printed `Fees and charges` line is $0.00; a refund inside a category |

`make_mock_statements.py` writes the PDFs and `mock-statements/manifest.json`. It uses only the standard library and is deterministic. After changing it, regenerate and commit the output; `test_mock_statements.py` fails when the committed files drift from the script. The test also checks the notice on every page, rejects issuer names, phone numbers and unmasked digit runs, confirms the traps above exist, checks that every reference label and amount is printed on its stated page, and runs every corpus mutation against the set.

Layout choices follow public descriptions of real statement structures: the US periodic statement headings in Regulation Z sample G-18(A) (summarized by [Consumer Compliance Outlook](https://www.consumercomplianceoutlook.org/articles/2009/second-issue-2009/the-regulation-z-amendments-for-open-end-credit-disclosures-part-two)), an issuer's published Singapore [statement sample](https://www.hsbc.com.sg/content/dam/hsbc/sg/documents/credit-cards/statement-sample.pdf) (post date first, `CR` credits, instalment rows), Debit and Credit column exports, and per-category spending summaries. Only the structure is imitated.

Five statements carry a `demo` field that says what each can show in the app's demo mode: a total reconciled against purchases rather than the closing balance (`sample-a1`), a potential-duplicate warning (`sample-a3`), a different layout with foreign currency (`sample-c1`), a PDF refused because it has no printed total (`sample-d1`), and category grouping (`sample-f1`). The app refuses any PDF statement whose rows it cannot reconcile against a printed total and imports no rows from it, so layouts D and E test extraction only; they cannot show queue features such as the duplicate warning.

```sh
python3 scripts/statement-eval/make_mock_statements.py
python3 -m unittest discover -s scripts/statement-eval -p 'test_*.py' -v
python3 scripts/statement-eval/runner.py --offline --manifest scripts/statement-eval/mock-statements/manifest.json
python3 scripts/statement-eval/corpus_stress.py scripts/statement-eval/mock-statements/manifest.json
```

The corpus stress checks mutate truth rows and printed references without sending PDFs or contacting Gemini. On the mock set they run 162 mutations: closing-balance and payment labels with the correct amount, missing, duplicated, misdated and sign-flipped rows, overlapping summaries, a dropped fee and offsetting row errors. For a statement with no printed reference, the correct answer is `null` and any offered reference counts as wrong evidence. Their result is written under `/tmp/divvy-eval`.

## Manifest format

```json
{
  "cases": [
    {
      "id": "case-name",
      "split": "development",
      "path": "statement.pdf",
      "transactions": [{ "date": "2026-01-31", "amount": 10.00 }],
      "expectedTotalCents": 1000,
      "referenceComponents": [{ "label": "Purchases & Other Charges", "amount": 10.00, "page": 1 }],
      "referenceAlternatives": []
    }
  ]
}
```

A relative `path` resolves beside the manifest file. `transactions` is the row truth. Repeat identical date and amount pairs when the PDF repeats them. `expectedTotalCents` is the signed row sum in cents. `referenceComponents` lists independent printed evidence, with 1-based PDF page numbers; set it and `expectedTotalCents` to `null` if no independent reference exists. A model's `null` then counts as correct abstention, without counting as a numeric reference or reconciliation. `referenceAlternatives` may contain other verified, nonoverlapping component sets that give the same total. Exact label, signed amount, and page must match one complete set. For a cardholder section label that ends at `Total of New Transactions for`, the check also accepts the printed cardholder suffix. It does not infer other aliases. A printed $0.00 component is ignored on both sides, so listing or omitting a zero line does not change the result. The verified optional `Plus` arithmetic prefix in Purchases/Fees reference labels is normalized by the oracle. The mock manifest also records `layout`, `closingBalanceCents` and, for some cases, `demo`; the scorer ignores them.

Keep any real statements out of git, in the ignored `scripts/statement-eval/private/` directory, with mode `0700` for the directory and `0600` for each file.

## Live evaluation

After fixing the prompt using **development** cases, run the held-out **test** cases once and report both splits separately. The default live split is development. Each invocation makes at most two requests per case and variant. `--baseline --split all --repeats 2` makes 52 requests for the 13-case mock manifest. Live runs cost money; the mock set has not been scored against a live model yet.

```sh
GEMINI_API_KEY=... python3 scripts/statement-eval/runner.py --live --manifest scripts/statement-eval/mock-statements/manifest.json --split development --baseline
python3 scripts/statement-eval/runner.py --live --manifest scripts/statement-eval/mock-statements/manifest.json --split test --baseline --env-file /absolute/private/path/.env
```

The env file is read as text for `GEMINI_API_KEY=...`; it is never executed. The key goes in a request header and is never written to results. The harness writes raw API responses and a score report with mode `0600` under `/tmp/divvy-eval`, whose directory must have mode `0700`. That directory is temporary storage and may be removed by the operating system. Copy its results elsewhere if they need to persist.

Scores compare row count and the multiset of `(date, signed amount cents)` against truth, then compare independent printed reference evidence and the model's arithmetic reconciliation. A matching net amount alone does not pass reference evidence: a closing balance can equal purchases by coincidence. `falseAccept` means the model's rows sum to its chosen reference but the rows or printed evidence are wrong. The baseline gives only a numeric `statementTotal`; its printed evidence is **unknown**, never scored as an evidence pass. Both variants are one model response per trial, recorded as `firstPassOnly: true`; this is not the production repair flow or a definitive end-to-end comparison. Merchant names and categories are not independently verified here, and the proposed schema is an evaluation candidate, not a production drop-in.

## Antigravity CLI evaluation

With existing Antigravity authentication:

```sh
python3 scripts/statement-eval/agy_runner.py --manifest scripts/statement-eval/mock-statements/manifest.json --split development --repeats 2
python3 scripts/statement-eval/agy_runner.py --manifest scripts/statement-eval/mock-statements/manifest.json --split test --repeats 2
```

Default model is `gemini-3.8-flash-low`; model and effort match. This path extracts PDF text locally with Poppler and gives the CLI agent one private input file to read. It does not test native PDF ingestion or the production API. Temporary input files are removed after each call. Statement text is kept out of process arguments. The runner rejects a CLI SUCCESS result unless actual structured extraction exists and no tool action was denied. `--prompt-file` and `--schema-file` can evaluate a captured production request; category enum validity is then checked separately from date/amount row accuracy.
