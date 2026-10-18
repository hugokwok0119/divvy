import hashlib
import json
import unittest
from collections import Counter
from pathlib import Path

import make_demo_results as demo


MANIFEST = Path(__file__).with_name("mock-statements") / "manifest.json"
OUTPUT = Path(__file__).resolve().parents[2] / "src" / "demo" / "sample-results.json"
NO_TOTAL = {"sample-d1", "sample-d2", "sample-e1", "sample-e2"}
FEATURED = {
    "sample-a1": "Matches the printed purchases plus fees ($3,009.05), not the -$490.95 closing balance.",
    "sample-a3": "The same charge appears twice on one day. Divvy flags the second as a possible duplicate.",
    "sample-c1": "A different layout: rows grouped by type, foreign-currency purchases and separate foreign "
                 "transaction fees.",
    "sample-f1": "Rows grouped by spending category, with points on every row.",
    "sample-d1": "Prints no purchase total, so there is nothing independent to check the rows against. "
                 "Divvy refuses it rather than guess.",
}


class DemoResultsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST.read_text())
        cls.cases = {case["id"]: case for case in cls.manifest["cases"]}
        cls.built = demo.build(MANIFEST)
        cls.samples = cls.built["samples"]

    def test_committed_file_matches_build(self):
        self.assertEqual(self.built, json.loads(OUTPUT.read_text()))

    def test_every_manifest_case_present(self):
        self.assertEqual([s["id"] for s in self.samples], [c["id"] for c in self.manifest["cases"]])
        self.assertEqual(len(self.samples), 13)

    def test_featured_set(self):
        featured = {s["id"]: s["description"] for s in self.samples if s["featured"]}
        self.assertEqual(featured, FEATURED)

    def test_no_total_cases_refused(self):
        for s in self.samples:
            self.assertEqual(s["status"], 422 if s["id"] in NO_TOTAL else 200, s["id"])
            if s["status"] == 422:
                self.assertEqual(s["body"]["reason"], "reconciliation_failed")
                self.assertIsNone(s["body"]["statementTotalCents"])

    def test_rows_match_manifest(self):
        for s in (s for s in self.samples if s["status"] == 200):
            case = self.cases[s["id"]]
            body = s["body"]
            got = Counter((r["date"], r["amountCents"]) for r in body["transactions"])
            want = Counter((t["date"], round(t["amount"] * 100)) for t in case["transactions"])
            self.assertEqual(got, want, s["id"])
            self.assertEqual(sum(r["amountCents"] for r in body["transactions"]), body["itemsTotalCents"])
            self.assertEqual(body["itemsTotalCents"], body["statementTotalCents"], s["id"])
            self.assertEqual(body["statementTotalCents"], case["expectedTotalCents"], s["id"])
            self.assertIs(body["reconciled"], True)
            first = body["transactions"][0]
            self.assertEqual({k: body[k] for k in first}, first)

    def test_categories_are_app_categories(self):
        categories = set(demo.app_categories())
        self.assertIn("Other", categories)
        for s in (s for s in self.samples if s["status"] == 200):
            for r in s["body"]["transactions"]:
                self.assertIn(r["category"], categories, s["id"])

    def test_sha256_matches_pdf(self):
        for s in self.samples:
            pdf = MANIFEST.parent / self.cases[s["id"]]["path"]
            self.assertEqual(s["fileName"], pdf.name)
            self.assertEqual(s["sha256"], hashlib.sha256(pdf.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
