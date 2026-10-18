"""Write src/demo/sample-results.json: the server response the demo replays for each mock statement.

The rows come from the mock generator's ground truth, not from Gemini. Run from anywhere:
    python3 scripts/statement-eval/make_demo_results.py
"""
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from make_mock_statements import statements


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name("mock-statements") / "manifest.json"
OUTPUT = ROOT / "src" / "demo" / "sample-results.json"
CATEGORY_MAP = {"Fee": "Other"}  # Fee is not an app category; see spec decision 14.
FEATURED = {
    "sample-a1": "Matches the printed purchases plus fees ($3,009.05), not the -$490.95 closing balance.",
    "sample-a3": "The same charge appears twice on one day. Divvy flags the second as a possible duplicate.",
    "sample-c1": "A different layout: rows grouped by type, foreign-currency purchases and separate foreign "
                 "transaction fees.",
    "sample-f1": "Rows grouped by spending category, with points on every row.",
    "sample-d1": "Prints no purchase total, so there is nothing independent to check the rows against. "
                 "Divvy refuses it rather than guess.",
}


def app_categories():
    """The CATEGORIES array literal in src/constants.ts, the enum the server gives Gemini."""
    source = (ROOT / "src" / "constants.ts").read_text()
    block = re.search(r"export const CATEGORIES = \[(.*?)\];", source, re.S)
    if not block:
        raise ValueError("CATEGORIES not found in src/constants.ts")
    return re.findall(r"'([^']*)'", block.group(1))


def build(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    categories = set(app_categories())
    generated = {s["id"]: s for s in statements()}
    samples = []
    for case in manifest["cases"]:
        sid = case["id"]
        rows = []
        # Payments are the generator's separate list; every section row is a purchase, refund or fee.
        for r in (r for section in generated[sid]["sections"] for r in section["rows"]):
            category = CATEGORY_MAP.get(r["category"], r["category"])
            if category not in categories:
                raise ValueError(f"{sid}: category {r['category']!r} is not in CATEGORIES")
            rows.append({"date": r["date"], "store": r["store"], "amountCents": r["amount"], "category": category})
        want = Counter((t["date"], round(t["amount"] * 100)) for t in case["transactions"])
        if Counter((r["date"], r["amountCents"]) for r in rows) != want:
            raise ValueError(f"{sid}: rows do not match the manifest transactions")
        items_total = sum(r["amountCents"] for r in rows)
        expected = case["expectedTotalCents"]
        if expected is None:
            status, body = 422, {
                "error": "Could not verify the statement total. No rows were imported.",
                "reason": "reconciliation_failed",
                "itemsTotalCents": items_total,
                "statementTotalCents": None,
            }
        else:
            if items_total != expected:
                raise ValueError(f"{sid}: rows sum to {items_total}, expected {expected}")
            status, body = 200, {**rows[0], "transactions": rows, "statementTotalCents": expected,
                                 "itemsTotalCents": items_total, "reconciled": True}
        pdf = manifest_path.parent / case["path"]
        samples.append({
            "id": sid,
            "fileName": pdf.name,
            "layout": case["layout"],
            "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
            "featured": sid in FEATURED,
            "description": FEATURED.get(sid, f"Layout {case['layout']} sample."),
            "status": status,
            "body": body,
        })
    return {"samples": samples}


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build(MANIFEST), indent=2) + "\n")


if __name__ == "__main__":
    main()
