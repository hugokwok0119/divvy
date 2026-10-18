import re
import unittest
from collections import Counter
from pathlib import Path

import corpus_stress
import make_mock_statements as mock
import runner


DIRECTORY = Path(__file__).with_name("mock-statements")
FORBIDDEN = re.compile(
    r"\b(bank|banque|trust|credit union|visa|mastercard|amex|american express|td|aeroplan|"
    r"rbc|cibc|scotia\w*|bmo|desjardins|chase|citi\w*|capital one|hsbc|barclays|broker\w*|interac)\b",
    re.IGNORECASE)


def page_texts(pdf):
    """Return the shown text of each page; the generator writes one uncompressed stream per page."""
    streams = re.findall(rb"stream\n(.*?)\nendstream", pdf, re.S)
    pages = re.findall(rb"/Type /Page\b(?!s)", pdf)
    assert len(streams) == len(pages), "one content stream per page"
    return [" ".join(re.sub(r"\\(.)", r"\1", s.decode("latin-1"))
                     for s in re.findall(rb"\(((?:\\.|[^\\)])*)\) Tj", stream)) for stream in streams]


class MockStatementTests(unittest.TestCase):
    def test_committed_files_match_the_generator(self):
        built = mock.build()
        self.assertEqual(sorted(built), sorted(p.name for p in DIRECTORY.iterdir()))
        for name, data in built.items():
            with self.subTest(name=name):
                self.assertEqual((DIRECTORY / name).read_bytes(), data, "rerun make_mock_statements.py")

    def test_manifest_is_valid_and_paths_resolve_beside_it(self):
        manifest = runner.load_manifest(DIRECTORY / "manifest.json")
        splits = {}
        for case in manifest["cases"]:
            splits.setdefault(case["layout"], set()).add(case["split"])
        self.assertEqual(set(splits), set("ABCDEF"))
        self.assertTrue(all(found == {"development", "test"} for found in splits.values()), splits)
        for case in manifest["cases"]:
            with self.subTest(case=case["id"]):
                self.assertTrue(Path(case["path"]).read_bytes().startswith(b"%PDF-"))

    def test_every_page_carries_the_fictional_notice(self):
        for name in mock.build():
            if name.endswith(".pdf"):
                for number, text in enumerate(page_texts((DIRECTORY / name).read_bytes()), 1):
                    with self.subTest(name=name, page=number):
                        self.assertIn(mock.NOTICE, text)

    def test_no_issuer_names_phone_numbers_or_long_digit_runs(self):
        for name in mock.build():
            data = (DIRECTORY / name).read_bytes()
            text = " ".join(page_texts(data)) if name.endswith(".pdf") else data.decode("utf-8")
            with self.subTest(name=name):
                self.assertIsNone(FORBIDDEN.search(text))
                if name.endswith(".pdf"):
                    self.assertIsNone(re.search(r"\d{3}[-. )]+\d{3}[-. ]\d{4}", text))
                    self.assertIsNone(re.search(r"\d{5,}|\d{4}[ -]\d{4}", text))
                    self.assertEqual(set(re.findall(r"X{4} (\d{4})", text)) - {"0000", "0001"}, set())

    def test_set_contains_the_known_extraction_traps(self):
        statements = mock.statements()
        rows = {s["id"]: [r for section in s["sections"] for r in section["rows"]] for s in statements}
        self.assertTrue(any(r["amount"] < 0 for s in rows.values() for r in s), "merchant refund")
        self.assertTrue(any(max(Counter((r["date"], r["store"], r["amount"]) for r in s).values()) > 1
                            for s in rows.values()), "repeated legitimate charge")
        self.assertTrue(any(r["date"] < s["opening"] for s in statements for r in rows[s["id"]]),
                        "row dated before the period opens")
        totals = {s["id"]: sum(r["amount"] for r in rows[s["id"]]) for s in statements}
        balances = {s["closing_balance"] == totals[s["id"]] for s in statements}
        self.assertEqual(balances, {True, False}, "closing balance both equals and differs from the total")
        self.assertTrue(any(s["closing_balance"] < 0 for s in statements), "credit balance after overpayment")
        texts = [t for n in mock.build() if n.endswith(".pdf") for t in page_texts((DIRECTORY / n).read_bytes())]
        self.assertTrue(any("(continued)" in t for t in texts), "transaction table continues on a later page")
        self.assertTrue(all(s["rewards"] for s in statements if s["layout"] == "A"), "rewards table repeats purchases")
        self.assertTrue(any(re.search(r"\d\.\d\d CR\b", t) for t in texts), "credits marked with a CR suffix")
        self.assertTrue(any(re.search(r"USD [\d,]+\.\d\d @ \d\.\d{4}", t) for t in texts), "foreign currency detail line")
        self.assertTrue(any(len({r["date"][:4] for r in rows[s["id"]]}) > 1 for s in statements), "period crosses a year end")
        manifest = runner.load_manifest(DIRECTORY / "manifest.json")
        self.assertTrue(any(c["referenceComponents"] is None for c in manifest["cases"]), "no printed reference to find")

    def test_reference_labels_and_amounts_are_printed_on_their_pages(self):
        manifest = runner.load_manifest(DIRECTORY / "manifest.json")
        for case in manifest["cases"]:
            pages = page_texts(Path(case["path"]).read_bytes())
            for component in [c for s in [case["referenceComponents"] or [], *case["referenceAlternatives"]] for c in s]:
                with self.subTest(case=case["id"], component=component):
                    text = pages[component["page"] - 1]
                    self.assertIn(component["label"].removeprefix("Plus "), text)
                    self.assertIn(f"{abs(component['amount']):,.2f}", text)

    def test_corpus_mutations_are_classified_correctly(self):
        manifest = runner.load_manifest(DIRECTORY / "manifest.json")
        results = corpus_stress.check_corpus(manifest)
        self.assertGreaterEqual(len(results), 10 * len(manifest["cases"]))
        self.assertTrue(all(r["correctlyClassified"] for r in results))


if __name__ == "__main__":
    unittest.main()
