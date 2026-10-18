#!/usr/bin/env python3
"""Mutation checks against a private ground-truth corpus; never calls Gemini."""
import copy
import json
from pathlib import Path
import sys
import runner


def check_corpus(manifest):
    runner.validate_manifest(manifest)
    results = []
    for case in manifest["cases"]:
        response = {
            "transactions": [{**row, "store": "Synthetic merchant"} for row in case["transactions"]],
            "reconciliationComponents": copy.deepcopy(case["referenceComponents"]),
        }
        variants = [("correct", copy.deepcopy(response), True)]
        # A case with no printed reference expects null; any printed amount offered is wrong evidence.
        printed = case["referenceComponents"] is not None
        total = case["expectedTotalCents"] if printed else sum(runner.cents(r["amount"]) for r in case["transactions"])
        for label in ("New Balance", "Total New Balance", "Payments & Credits", "Rewards balance"):
            item = copy.deepcopy(response)
            item["reconciliationComponents"] = [{"label": label, "amount": total / 100, "page": 1}]
            variants.append((label, item, False))
        for name in ("missing row", "duplicate row", "wrong date", "wrong sign", "overlapping summaries", "null reference", "invalid page", "missing fee"):
            if not printed and name in ("overlapping summaries", "null reference", "invalid page", "missing fee"):
                continue
            item = copy.deepcopy(response)
            if name == "missing row": item["transactions"].pop(0)
            elif name == "duplicate row": item["transactions"].append(copy.deepcopy(item["transactions"][0]))
            elif name == "wrong date": item["transactions"][0]["date"] = "2000-01-01"
            elif name == "wrong sign": item["transactions"][0]["amount"] *= -1
            elif name == "overlapping summaries": item["reconciliationComponents"] *= 2
            elif name == "null reference": item["reconciliationComponents"] = None
            elif name == "invalid page": item["reconciliationComponents"][0]["page"] = 0
            elif name == "missing fee":
                fees = [c for c in case["referenceComponents"] if "fees" in c["label"].casefold() and c["amount"]]
                if not fees: continue
                amount = fees[0]["amount"]
                # A fee total can add up several fee rows; the mutation needs one row equal to it.
                idx = next((i for i,r in enumerate(item["transactions"]) if r["amount"] == amount), None)
                if idx is None: continue
                item["transactions"].pop(idx)
            variants.append((name, item, False))
        # Distinct rows can be lost/duplicated while total stays unchanged.
        item = copy.deepcopy(response)
        item["transactions"][0]["amount"] += 1
        item["transactions"][1]["amount"] -= 1
        variants.append(("offsetting row errors", item, False))
        for name, item, expected in variants:
            metrics = runner.score(case, item)
            if name in ("New Balance", "Total New Balance", "Payments & Credits", "Rewards balance"):
                assert metrics["rowExact"] and metrics["referenceAmountExact"] is (True if printed else None) and metrics["reconciled"], (case["id"], name, metrics)
                assert not metrics["referenceExact"] and metrics["falseAccept"], (case["id"], name, metrics)
            if name == "offsetting row errors" and printed:
                assert not metrics["rowExact"] and metrics["referenceExact"] and metrics["reconciled"] and metrics["falseAccept"], (case["id"], name, metrics)
            passed = metrics["schemaValid"] and metrics["rowExact"] and metrics["referenceExact"] and (metrics["reconciled"] or not printed)
            if bool(passed) != expected:
                raise AssertionError(f"{case['id']}: {name} incorrectly scored")
            results.append({"case":case["id"], "split":case["split"], "mutation":name, "correctlyClassified":True, **metrics})
    return results


if __name__ == "__main__":
    manifest = json.loads(Path(sys.argv[1]).read_text())
    results = check_corpus(manifest)
    output = runner.save_private("corpus-stress-" + runner.uuid.uuid4().hex[:12] + ".json", {"results":results})
    print(f"Corpus mutation checks: {len(results)} passed across {len(manifest['cases'])} statements")
    print(f"Private result: {output}")
