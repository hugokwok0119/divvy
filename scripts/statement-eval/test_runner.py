import unittest
import json

import runner


CASE = {
    "id": "sample",
    "split": "development",
    "path": "/tmp/sample.pdf",
    "transactions": [
        {"date": "2026-01-01", "amount": 10.00},
        {"date": "2026-01-02", "amount": -2.00},
    ],
    "expectedTotalCents": 800,
    "referenceComponents": [{"label": "Net purchases", "amount": 8.00, "page": 2}],
}


def response(rows=None, components=None):
    return {
        "transactions": rows if rows is not None else [
            {"date": "2026-01-01", "store": "A", "amount": 10.00},
            {"date": "2026-01-02", "store": "B", "amount": -2.00},
        ],
        "reconciliationComponents": components if components is not None else [
            {"label": "Net purchases", "amount": 8.00, "page": 2},
        ],
    }


class EvaluationTests(unittest.TestCase):
    def test_exact_rows_and_reference_pass(self):
        score = runner.score(CASE, response())
        self.assertTrue(score["rowExact"])
        self.assertTrue(score["referenceExact"])
        self.assertTrue(score["reconciled"])

    def test_equal_total_does_not_hide_missing_or_duplicate_rows(self):
        missing = response(rows=[
            {"date": "2026-01-01", "store": "A", "amount": 10.00},
        ], components=[{"label": "Wrong total", "amount": 10.00, "page": 2}])
        duplicate = response(rows=[
            {"date": "2026-01-01", "store": "A", "amount": 10.00},
            {"date": "2026-01-02", "store": "B", "amount": -2.00},
            {"date": "2026-01-02", "store": "B", "amount": -2.00},
        ], components=[{"label": "Wrong total", "amount": 6.00, "page": 2}])
        for result in (missing, duplicate):
            score = runner.score(CASE, result)
            self.assertTrue(score["reconciled"])
            self.assertFalse(score["rowExact"])
            self.assertFalse(score["referenceExact"])
            self.assertTrue(score["falseAccept"])

    def test_flipped_refund_and_wrong_summary_fail(self):
        flipped = response(rows=[
            {"date": "2026-01-01", "store": "A", "amount": 10.00},
            {"date": "2026-01-02", "store": "B", "amount": 2.00},
        ])
        closing = response(components=[{"label": "Closing balance", "amount": 108.00, "page": 2}])
        doubled = response(components=[
            {"label": "Account total", "amount": 8.00, "page": 2},
            {"label": "Section total", "amount": 8.00, "page": 2},
        ])
        self.assertFalse(runner.score(CASE, flipped)["rowExact"])
        self.assertFalse(runner.score(CASE, closing)["referenceExact"])
        self.assertFalse(runner.score(CASE, doubled)["referenceExact"])

    def test_matching_amount_with_closing_balance_label_fails(self):
        result = response(components=[{"label": "Closing balance", "amount": 8.00, "page": 2}])
        score = runner.score(CASE, result)
        self.assertTrue(score["reconciled"])
        self.assertFalse(score["referenceExact"])
        self.assertTrue(score["falseAccept"])

    def test_verified_alternative_section_subtotals_pass(self):
        case = dict(CASE, referenceAlternatives=[[
            {"label": "Purchase section", "amount": 10.00, "page": 3},
            {"label": "Refund section", "amount": -2.00, "page": 4},
        ]])
        result = response(components=case["referenceAlternatives"][0])
        self.assertTrue(runner.score(case, result)["referenceExact"])

    def test_verified_cardholder_total_prefix_passes(self):
        case = dict(CASE, referenceAlternatives=[[
            {"label": "Total of New Transactions for", "amount": 8.00, "page": 3},
        ]])
        result = response(components=[
            {"label": "Total of New Transactions for Jane Doe", "amount": 8.00, "page": 3},
        ])
        self.assertTrue(runner.score(case, result)["referenceExact"])

    def test_arithmetic_plus_prefix_is_optional_for_account_labels(self):
        case = dict(CASE, referenceComponents=[{"label": "Plus Purchases", "amount": 8, "page": 2}])
        self.assertTrue(runner.score(case, response(components=[{"label": "Purchases", "amount": 8, "page": 2}]))["referenceExact"])

    def test_zero_amount_components_are_not_evidence_either_way(self):
        extra_zero = response(components=[
            {"label": "Net purchases", "amount": 8.00, "page": 2},
            {"label": "Interest Charged", "amount": 0, "page": 2},
        ])
        self.assertTrue(runner.score(CASE, extra_zero)["referenceExact"])
        only_zero = response(components=[{"label": "Interest Charged", "amount": 0, "page": 2}])
        self.assertFalse(runner.score(CASE, only_zero)["referenceExact"])

    def test_manifest_rejects_invalid_alternative_structure(self):
        with self.assertRaises(ValueError):
            runner.validate_manifest({"cases": [dict(CASE, referenceAlternatives=None)]})

    def test_null_reference_is_unavailable(self):
        result = response()
        result["reconciliationComponents"] = None
        score = runner.score(CASE, result)
        self.assertTrue(score["rowExact"])
        self.assertFalse(score["referenceExact"])
        self.assertFalse(score["reconciled"])

    def test_null_reference_is_correct_when_truth_has_no_reference(self):
        case = dict(CASE, expectedTotalCents=None, referenceComponents=None)
        result = response()
        result["reconciliationComponents"] = None
        score = runner.score(case, result)
        self.assertTrue(score["rowExact"])
        self.assertTrue(score["referenceExact"])
        self.assertIsNone(score["referenceAmountExact"])
        self.assertFalse(score["reconciled"])

    def test_wrong_types_pages_and_nonfinite_numbers_are_invalid(self):
        cases = [
            {**response(), "transactions": [{"date": "2026-01-01", "store": "A", "amount": "10"}]},
            response(components=[{"label": "Net", "amount": 8.00, "page": 0}]),
            response(components=[{"label": "Net", "amount": 8.00, "page": "2"}]),
            response(components=[{"label": "Net", "amount": float("nan"), "page": 2}]),
            response(rows=[{"date": "2026-01-01", "store": "A", "amount": float("inf")}]),
        ]
        for result in cases:
            with self.subTest(result=result):
                self.assertFalse(runner.score(CASE, result)["schemaValid"])

    def test_manifest_rejects_inconsistent_truth(self):
        bad = dict(CASE, expectedTotalCents=900)
        with self.assertRaises(ValueError):
            runner.validate_manifest({"cases": [bad]})

    def test_request_has_schema_and_header_key(self):
        request = runner.make_request(b"%PDF-1.4\n", "secret", baseline=False)
        self.assertNotIn("secret", request.full_url)
        self.assertEqual(request.get_header("X-goog-api-key"), "secret")
        self.assertIn(b"reconciliationComponents", request.data)

    def test_candidate_request_uses_tested_model_and_low_thinking(self):
        request = runner.make_request(b"%PDF-1.4\n", "secret")
        body = json.loads(request.data)
        self.assertIn("gemini-3.8-flash:generateContent", request.full_url)
        self.assertEqual(body["generationConfig"]["thinkingConfig"], {"thinkingLevel": "LOW"})
        self.assertNotIn("temperature", body["generationConfig"])

    def test_baseline_request_keeps_old_generation_config(self):
        request = runner.make_request(b"%PDF-1.4\n", "secret", baseline=True)
        body = json.loads(request.data)
        self.assertEqual(body["generationConfig"], {"responseMimeType": "application/json"})

    def test_offline_adversaries(self):
        self.assertEqual(runner.offline_check(), 0)


if __name__ == "__main__":
    unittest.main()
