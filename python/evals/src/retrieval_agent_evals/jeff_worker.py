"""Run Jeff's one-pass decision checkpoint on frozen test rows only."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import sys
import time
import statistics
from pathlib import Path
from typing import Any, Callable

from .neural_worker import _prompts, _selected_test
from .experiment import digest

SOURCE_COMMIT = "2c1bfce27a394ce48869951332b30aedfba3b7b0"
MODEL_ID = "mstrasser/Jeff-Qwen3.5-0.8B"
MODEL_REVISION = "d66458d54426fcf52046b896261df8909bbc8b05"
BASE_MODEL_ID = "Qwen/Qwen3.5-0.8B"
BASE_MODEL_REVISION = "2fc06364715b967f1860aea9cf38778875588b17"
MAX_PROMPT_TOKENS = 8192


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _jeff_material(row: dict[str, str]) -> str:
    return f"[标题] {row['title']}\n[摘要] {row['summary']}"


def _jeff_question(manifest: dict[str, Any]) -> dict[str, Any]:
    question = _prompts(manifest)["relevant"]
    question["instructions"] = question["instructions"].replace(
        "标题和摘要可帮助定位主题，但与工单原文冲突时以原文为准。",
        "本次工单材料仅包含标题和摘要，依据所给材料判断。")
    return question


def _fit_state_prefix(state: str, question: dict[str, Any], model: Any,
                      render_tokens: Callable[[str, dict[str, Any], Any], tuple[str, Any, int]],
                      max_prompt_tokens: int = MAX_PROMPT_TOKENS) -> dict[str, Any]:
    """用完整官方prompt测预算，仅裁剪state尾部，查询、边界和选项保持原样。"""
    original_text, original_ids, original_prompt_tokens = render_tokens(state, question, model)
    state_ids = model.processor.tokenizer.encode(state, add_special_tokens=False)
    original_state_tokens = len(state_ids)
    if original_prompt_tokens <= max_prompt_tokens:
        return {"state": state, "rendered": original_text, "input_ids": original_ids,
                "input_tokens": original_prompt_tokens, "state_original_tokens": original_state_tokens,
                "state_used_tokens": original_state_tokens, "state_truncated": False}

    _, _, empty_prompt_tokens = render_tokens("", question, model)
    if empty_prompt_tokens > max_prompt_tokens:
        raise ValueError("query, guidance, or binary options exceed the fixed 8192-token prompt budget")

    tokenizer = model.processor.tokenizer
    def prefix(count: int) -> str:
        return tokenizer.decode(state_ids[:count], skip_special_tokens=False,
                                clean_up_tokenization_spaces=False)

    low, high = 0, len(state_ids)
    best = ("", None, None, 0)
    while low <= high:
        middle = (low + high) // 2
        candidate = prefix(middle)
        rendered, ids, token_count = render_tokens(candidate, question, model)
        if token_count <= max_prompt_tokens:
            best = (candidate, rendered, ids, token_count)
            low = middle + 1
        else:
            high = middle - 1
    cropped, rendered, input_ids, input_tokens = best
    if input_ids is None:
        raise ValueError("no state prefix fits the fixed prompt budget")
    used_tokens = len(tokenizer.encode(cropped, add_special_tokens=False))
    return {"state": cropped, "rendered": rendered, "input_ids": input_ids,
            "input_tokens": input_tokens, "state_original_tokens": original_state_tokens,
            "state_used_tokens": used_tokens, "state_truncated": True}


def _condition_rows(condition_dir: Path) -> tuple[list[dict[str, str]], dict[str, Any]]:
    rows, manifest = _selected_test(condition_dir)
    return rows, manifest


def _load_jeff(model_path: Path, source_path: Path):
    source_root = source_path.resolve()
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
    from jeff.model import DecisionModel, decision_messages
    model = DecisionModel(checkpoint=model_path, device="cuda")
    model.eval()
    return model, decision_messages


def _render_tokens(state: str, question: dict[str, Any], model: Any,
                   decision_messages: Callable) -> tuple[str, Any, int]:
    from jeff.model import DecisionInput
    row: DecisionInput = {"state": state, "question": question}
    messages = decision_messages(row, model.codes, model.prompt_layout)
    rendered = model.processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    encoded = model.processor(text=[rendered], images=None, padding=True, return_tensors="pt")
    ids = encoded["input_ids"]
    tokens = int(encoded["attention_mask"].sum())
    return rendered, ids, tokens


def _run_condition(condition_dir: Path, output_root: Path, model: Any,
                   decision_messages: Callable, model_load_seconds: float,
                   source_hashes: dict[str, str]) -> dict[str, Any]:
    import torch

    rows, manifest = _condition_rows(condition_dir)
    question = _jeff_question(manifest)
    question_hash = _hash(json.dumps(question, ensure_ascii=False, sort_keys=True))
    out_dir = output_root / manifest["condition_id"] / "neural" / "jeff_qwen35_08b"
    out_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = out_dir / "predictions.jsonl"
    if predictions_path.exists():
        raise FileExistsError(f"refusing to overwrite existing Jeff predictions: {predictions_path}")

    wall_started = time.perf_counter()
    inference_seconds = 0.0
    preflight_seconds = 0.0
    token_total = 0
    truncated_rows = 0
    prompt_hashes = set()
    with predictions_path.open("w", encoding="utf-8", newline="\n") as output:
        for row in rows:
            original_state = _jeff_material(row)
            prep_started = time.perf_counter()
            fit = _fit_state_prefix(
                original_state, question, model,
                lambda state, q, m: _render_tokens(state, q, m, decision_messages))
            preflight_seconds += time.perf_counter() - prep_started
            prompt_hashes.add(_hash(fit["rendered"]))
            if fit["state_truncated"]:
                truncated_rows += 1

            request = {"state": fit["state"], "question": question}
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            started = time.perf_counter()
            probabilities = model.predict([request], batch_size=1)[0]
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
            inference_seconds += elapsed
            score = float(probabilities[0])
            choice = "A" if score >= float(probabilities[1]) else "B"
            record = {
                "ticket_id": row["ticket_id"],
                "prediction": int(choice == "A"),
                "score": score,
                "elapsed_seconds": elapsed,
                "input_sha256": _hash(fit["rendered"]),
                "raw_input_sha256": _hash(original_state),
                "input_tokens": fit["input_tokens"],
                "state_original_tokens": fit["state_original_tokens"],
                "state_used_tokens": fit["state_used_tokens"],
                "state_dropped_tokens": fit["state_original_tokens"] - fit["state_used_tokens"],
                "state_truncated": fit["state_truncated"],
                "raw_choice": choice,
                "raw_probabilities": {"A": float(probabilities[0]), "B": float(probabilities[1])},
            }
            token_total += fit["input_tokens"]
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
            output.flush()

    environment = {
        "method": "jeff", "method_id": "jeff_qwen35_08b",
        "model": MODEL_ID, "model_revision": MODEL_REVISION,
        "base_model": BASE_MODEL_ID, "base_model_revision": BASE_MODEL_REVISION,
        "source_commit": SOURCE_COMMIT, "source_hashes": source_hashes,
        "condition_id": manifest["condition_id"], "candidate_sha256": digest(condition_dir / "candidates.jsonl"),
        "count": len(rows), "elapsed_seconds": time.perf_counter() - wall_started,
        "model_load_seconds_shared": model_load_seconds,
        "inference_seconds_total": inference_seconds, "preflight_seconds_total": preflight_seconds,
        "calls": len(rows), "input_tokens_total": token_total, "truncated_rows": truncated_rows,
        "label_access": "none", "input_fields": ["title", "summary"],
        "prompt_sha256": question_hash, "rendered_prompt_sha256_count": len(prompt_hashes),
        "parameters": {"max_prompt_tokens": MAX_PROMPT_TOKENS,
                       "state_truncation_strategy": "token_prefix_drop_tail",
                       "batch_size": 1, "temperature": model.temperature,
                       "prompt_layout": model.prompt_layout},
        "python": sys.version.split()[0], "runtime_python": str(Path(sys.executable).resolve()),
        "torch": importlib.metadata.version("torch"),
        "torchvision": importlib.metadata.version("torchvision"),
        "pillow": importlib.metadata.version("pillow"),
        "transformers": importlib.metadata.version("transformers"),
        "dtype": str(next(model.parameters()).dtype), "device": model.device_name,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "language_note": "Chinese input; upstream documents English-only support, so this is an out-of-spec exploratory stress test.",
        "status": "completed",
    }
    (out_dir / "environment.json").write_text(
        json.dumps(environment, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return environment


def _smoke(model_path: Path, source_path: Path, conditions_root: Path | None = None) -> dict[str, Any]:
    import torch
    model, decision_messages = _load_jeff(model_path, source_path)
    synthetic_question = {"type": "choice", "instructions": "判断材料是否提到测试服务故障。",
                          "criteria": {"A": "相关", "B": "不相关"}}
    cases = [("synthetic_short", "[标题] 测试服务无法登录\n[摘要] 测试账号无法访问服务。",
              synthetic_question)]
    longest = None
    if conditions_root is not None:
        for condition_dir in sorted(path for path in conditions_root.iterdir()
                                    if path.is_dir() and (path / "candidates.jsonl").exists()):
            rows, manifest = _condition_rows(condition_dir)
            question = _jeff_question(manifest)
            for row in rows:
                state = _jeff_material(row)
                tokens = _render_tokens(state, question, model, decision_messages)[2]
                if longest is None or tokens > longest[0]:
                    longest = (tokens, state, question, row["ticket_id"], manifest["condition_id"])
    if longest is not None:
        cases.append((f"longest_test_prompt:{longest[4]}", longest[1], longest[2]))
    results = []
    for name, state, question in cases:
        fit = _fit_state_prefix(state, question, model,
                                lambda item, q, m: _render_tokens(item, q, m, decision_messages))
        request = {"state": fit["state"], "question": question}
        started = time.perf_counter()
        probabilities = model.predict([request], batch_size=1)[0]
        torch.cuda.synchronize()
        results.append({"case": name, "input_tokens": fit["input_tokens"],
                        "state_truncated": fit["state_truncated"],
                        "state_original_tokens": fit["state_original_tokens"],
                        "state_used_tokens": fit["state_used_tokens"],
                        "inference_seconds": time.perf_counter() - started,
                        "probabilities": [float(probabilities[0]), float(probabilities[1])]})
    return {"model_revision": MODEL_REVISION, "device": model.device_name,
            "dtype": str(next(model.parameters()).dtype), "label_access": "none",
            "warmup_calls": len(results), "smoke": results}


def audit_frozen_prompts(conditions_root: Path, model_path: Path, source_path: Path) -> dict[str, Any]:
    source_root = source_path.resolve()
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
    from jeff.model import decision_messages
    from transformers import AutoProcessor
    config = json.loads((model_path / "decision_config.json").read_text(encoding="utf-8"))
    processor = AutoProcessor.from_pretrained(str(model_path.resolve()))
    processor.tokenizer.padding_side = "left"
    processor.image_processor.size = {"shortest_edge": 65536, "longest_edge": 262144}
    tokenizer_model = type("TokenizerModel", (), {
        "processor": processor, "codes": config["codes"],
        "prompt_layout": config.get("prompt_layout", "state-first")})()
    results = {}
    all_tokens = []
    for condition_dir in sorted(path for path in conditions_root.iterdir()
                                if path.is_dir() and (path / "candidates.jsonl").exists()):
        rows, manifest = _condition_rows(condition_dir)
        question = _jeff_question(manifest)
        tokens = [_render_tokens(_jeff_material(row), question, tokenizer_model, decision_messages)[2]
                  for row in rows]
        all_tokens.extend(tokens)
        results[manifest["condition_id"]] = {
            "candidate_sha256": digest(condition_dir / "candidates.jsonl"),
            "count": len(tokens), "min": min(tokens), "p50": statistics.median(tokens),
            "p95": sorted(tokens)[(95 * len(tokens) + 99) // 100 - 1],
            "max": max(tokens),
            "over_limit": sum(value > MAX_PROMPT_TOKENS for value in tokens)}
    all_sorted = sorted(all_tokens)
    return {"model": MODEL_ID, "model_revision": MODEL_REVISION,
            "base_model_revision": config["revision"], "source_commit": SOURCE_COMMIT,
            "limit_tokens": MAX_PROMPT_TOKENS, "input_fields": ["title", "summary"],
            "uses_query": True, "label_access": "none", "by_condition": results,
            "overall": {"count": len(all_tokens), "min": min(all_tokens),
                        "p50": statistics.median(all_tokens),
                        "p95": all_sorted[(95 * len(all_sorted) + 99) // 100 - 1],
                        "max": max(all_tokens),
                        "over_limit": sum(value > MAX_PROMPT_TOKENS for value in all_tokens)}}


def run_many(conditions_root: Path, model_path: Path, source_path: Path,
             output_root: Path) -> list[dict[str, Any]]:
    source_files = [source_path / "jeff" / "model.py", source_path / "jeff" / "types.py"]
    source_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files}
    started = time.perf_counter()
    model, decision_messages = _load_jeff(model_path, source_path)
    model_load_seconds = time.perf_counter() - started
    reports = []
    failures = []
    for condition_dir in sorted(path for path in conditions_root.iterdir()
                                if path.is_dir() and (path / "candidates.jsonl").exists()):
        try:
            reports.append(_run_condition(condition_dir, output_root, model, decision_messages,
                                          model_load_seconds, source_hashes))
        except Exception as exc:
            failure_dir = output_root / condition_dir.name / "neural" / "jeff_qwen35_08b"
            failure_dir.mkdir(parents=True, exist_ok=True)
            environment_path = failure_dir / "environment.json"
            if not environment_path.exists():
                failure = {"method": "jeff", "method_id": "jeff_qwen35_08b",
                           "model": MODEL_ID, "model_revision": MODEL_REVISION,
                           "base_model": BASE_MODEL_ID, "base_model_revision": BASE_MODEL_REVISION,
                           "source_commit": SOURCE_COMMIT, "condition_id": condition_dir.name,
                           "label_access": "none", "status": "incomplete",
                           "error_type": type(exc).__name__, "error": str(exc),
                           "model_load_seconds_shared": model_load_seconds,
                           "language_note": "Chinese input; upstream documents English-only support, so this is an out-of-spec exploratory stress test."}
                environment_path.write_text(json.dumps(failure, ensure_ascii=False, indent=2) + "\n",
                                            encoding="utf-8")
            failures.append(f"{condition_dir.name}:{type(exc).__name__}:{exc}")
    if failures:
        raise RuntimeError("Jeff condition failures: " + "; ".join(failures))
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the pinned Jeff decision checkpoint on frozen test tickets.")
    parser.add_argument("--conditions-root", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--smoke", action="store_true", help="Run only synthetic short/long inputs.")
    parser.add_argument("--audit", action="store_true", help="Count exact prompts for all frozen test rows only.")
    parser.add_argument("--artifact-output", type=Path,
                        help="Write smoke or prompt-audit JSON to this local path.")
    args = parser.parse_args(argv)
    if args.smoke:
        result = _smoke(args.model, args.source, args.conditions_root)
        rendered = json.dumps(result, ensure_ascii=False, indent=2)
        if args.artifact_output:
            args.artifact_output.parent.mkdir(parents=True, exist_ok=True)
            args.artifact_output.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 0
    if args.audit:
        if args.conditions_root is None:
            parser.error("--conditions-root is required with --audit")
        result = audit_frozen_prompts(args.conditions_root, args.model, args.source)
        rendered = json.dumps(result, ensure_ascii=False, indent=2)
        if args.artifact_output:
            args.artifact_output.parent.mkdir(parents=True, exist_ok=True)
            args.artifact_output.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 0
    if args.conditions_root is None:
        parser.error("--conditions-root is required unless --smoke is set")
    output_root = args.output_root or args.conditions_root
    reports = run_many(args.conditions_root, args.model, args.source, output_root)
    print(json.dumps(reports, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
