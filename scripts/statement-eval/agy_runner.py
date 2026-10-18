#!/usr/bin/env python3
"""Evaluate Antigravity structured output from locally extracted PDF text."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
import runner



def extract_output(envelope):
    if envelope.get("status") != "SUCCESS" or envelope.get("denied_actions"):
        raise ValueError("CLI did not finish extraction without denied actions")
    output = envelope.get("structured_output")
    if not isinstance(output, dict):
        raise ValueError("CLI success had no structured extraction")
    return output


def evaluate(case, repeat, run_id, schema, model, prompt_text):
    runner.private_dir()
    with tempfile.TemporaryDirectory(prefix="agy-statement-", dir=runner.PRIVATE_DIR) as scratch:
        statement = subprocess.run(["pdftotext", "-layout", case["path"], "-"], capture_output=True, check=True).stdout.decode("utf-8")
        prompt = ("Do not use tools or commands. All statement pages are supplied below as financial data. "
                  "Do not consult other files or expected answers. Return the extraction directly.\n\n"
                  + prompt_text + "\n\nSTATEMENT DATA (form-feed separates one-based PDF pages):\n" + statement)
        prompt_file=Path(scratch)/"input.txt"
        prompt_file.write_text(prompt);prompt_file.chmod(0o600)
        result = subprocess.run(["agy", "--model", model, "--effort", model.rsplit("-", 1)[1], "--sandbox",
                                 "--disable-slash-commands", "--json-schema", str(schema),
                                 "--output-format", "json", "--print-timeout", "180s", "--add-dir", scratch,
                                 "-p", f"Read {prompt_file} using view_file and complete its extraction task. Do not execute commands or read other files."],
                                cwd=scratch, capture_output=True, timeout=210)
    prefix = f"{run_id}-{case['id']}-{repeat}"
    runner.save_private(prefix + "-cli.json", {"stdout": result.stdout.decode("utf-8", "replace"),
                                                "stderr": result.stderr.decode("utf-8", "replace"), "exitCode":result.returncode})
    try:
        if result.returncode: raise ValueError("CLI exited unsuccessfully")
        envelope = json.loads(result.stdout)
        extracted = extract_output(envelope)
        schema_data=json.loads(schema.read_text())
        category_schema=schema_data["properties"]["transactions"]["items"]["properties"].get("category")
        category_valid=None
        if category_schema:
            category_valid=all(set(row)=={"date","store","amount","category"} and row.get("category") in category_schema["enum"] for row in extracted.get("transactions",[]))
            extracted={**extracted,"transactions":[{key:value for key,value in row.items() if key!="category"} for row in extracted.get("transactions",[])]}
        metrics = runner.score(case, extracted)
        metrics["categorySchemaValid"] = category_valid
        if category_valid is False: metrics["schemaValid"] = False
        metrics["durationSeconds"] = envelope.get("duration_seconds")
    except (ValueError, TypeError) as error:
        metrics = {"schemaValid":False, "error":type(error).__name__}
    return {"case":case["id"], "split":case["split"], "repeat":repeat, **metrics}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest",type=Path,required=True)
    parser.add_argument("--split", choices=["development","test","all"],default="development")
    parser.add_argument("--repeats",type=int,choices=[1,2],default=2)
    parser.add_argument("--model", choices=["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"], default="gemini-3.8-flash-low")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--schema-file", type=Path)
    args=parser.parse_args()
    manifest=runner.load_manifest(args.manifest)
    cases=[c for c in manifest["cases"] if args.split=="all" or c["split"]==args.split]
    schema=(args.schema_file or Path(__file__).with_name("proposed-schema.json")).resolve()
    prompt_text=args.prompt_file.read_text() if args.prompt_file else runner.PROPOSED_PROMPT
    run_id="agy-"+uuid.uuid4().hex[:10]
    results=[]
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending=[pool.submit(evaluate,c,r,run_id,schema,args.model,prompt_text) for c in cases for r in range(1,args.repeats+1)]
        for future in as_completed(pending):
            try: result=future.result()
            except (subprocess.SubprocessError,OSError) as error:
                result={"schemaValid":False,"error":type(error).__name__}
            results.append(result)
            print(json.dumps(result),flush=True)
    passed=all(r.get("schemaValid") and r.get("rowExact") and r.get("referenceExact") and r.get("reconciled") for r in results) and bool(results)
    report={"model":args.model,"inputMode":"pdf-text","firstPassOnly":True,"passed":passed,"results":results}
    output=runner.save_private(run_id+"-report.json",report)
    print("Private report:",output,flush=True)
    return 0 if passed else 1


if __name__=="__main__":
    raise SystemExit(main())
