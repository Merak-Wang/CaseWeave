"""Merge frozen test predictions and write a pseudo-label experiment report."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from .binary_metrics import score_binary
from .experiment import read_jsonl
from .operators import METHODS


METHOD_SCOPE = {
    "logistic_regression": ("supervised classifier", "current CaseWeave CPU baseline", "StandardScaler; C=1; balanced sample weights; threshold .5"),
    "linear_svm": ("supervised classifier", "current CaseWeave CPU baseline", "StandardScaler; C=1; dual=auto; balanced sample weights; threshold 0"),
    "mlp": ("supervised classifier", "current CaseWeave CPU baseline", "StandardScaler; 32 hidden units; alpha=.01; 250 iterations; threshold .5"),
    "hist_gradient_boosting": ("supervised classifier", "current CaseWeave CPU baseline", "80 iterations; 15 leaves; L2=1; balanced sample weights; threshold .5"),
    "name_gmm": ("zero-label", "query-anchor projection GMM; analogous to old NameGMM, not an exact port", "two Gaussian components; n_init=8; higher-similarity component is positive"),
    "spherical_kmeans": ("zero-label", "spherical K-means query-anchor assignment", "K=2; cosine assignment and normalized-centroid update"),
    "feedback_margin": ("feedback", "old M4 Feedback Margin", "cosine to positive centroid minus cosine to negative centroid; threshold 0"),
    "feedback_multi_prototype": ("feedback", "old M5 Feedback Multi-Prototype", "KMeans positive/negative prototypes; K=3/3; threshold 0"),
    "feedback_knn_margin": ("feedback", "new implementation of catalogued kNN margin; not an old completed result", "mean top-3 positive similarities minus mean top-3 negative similarities"),
    "hard_negative_memory": ("feedback", "old M7 Hard-Negative Memory", "diverse farthest-first positive/negative memories; limits 4/8"),
    "relation_logistic": ("feedback", "old M9 Learned Similarity Gate, eight embedding relation features", "positive/negative centroids, nearest prototypes, leader and margins; logistic gate"),
    "relation_conformal": ("feedback/selective", "old M10 relation conformal idea with held-out calibration", "train-only stratified fit/calibration split 3:1; alpha=.1 selective threshold"),
    "laya": ("zero-shot neural", "existing local Laya full-text Choice API", "same query/guidance; 8192 state tokens; 512 prompt-head tokens; argmax"),
    "julia": ("zero-shot neural", "existing local Julia-1 Choice API", "same query/guidance; max_length=8192; head_length=512; keep input prefix and drop tail only when state is over budget; query/options preflight lossless"),
    "gliner_official": ("zero-shot neural", "existing local GLiNER2.5-Decide", "one chunk inference; upstream max-confidence chunk merge"),
    "gliner_any_positive": ("zero-shot neural", "existing local GLiNER2.5-Decide", "same chunk outputs; any chunk positive OR rule"),
    "all_positive": ("trivial reference", "test-label-only reference; never fit or deployed", "predict relevant for every test row; zero model calls"),
    "all_negative": ("trivial reference", "test-label-only reference; never fit or deployed", "predict irrelevant for every test row; zero model calls"),
}


def _digest_ids(ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()


def _load_condition(condition_dir: Path, cpu_results: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = json.loads((condition_dir / "manifest.json").read_text(encoding="utf-8"))
    candidates = read_jsonl(condition_dir / "candidates.jsonl")
    test_ids = [str(row["ticket_id"]) for row in candidates if row.get("split") == "test"]
    train_ids = [str(row["ticket_id"]) for row in candidates if row.get("split") == "train"]
    if len(train_ids) != 128 or len(test_ids) != 128 or len(set(test_ids)) != 128:
        raise ValueError(f"{condition_dir.name}: frozen candidates are not 128/128 with unique test identities")
    label_path = condition_dir / "labeled.jsonl"
    labeled = read_jsonl(label_path) if label_path.exists() else []
    test = [row for row in labeled if row.get("split") == "test"]
    train = [row for row in labeled if row.get("split") == "train"]
    label_rows = [row for row in test if row.get("label_source") == "deepseek-v4.1-flash" and row.get("label") in (0, 1)]
    train_label_rows = [row for row in train if row.get("label_source") == "deepseek-v4.1-flash" and row.get("label") in (0, 1)]
    if len({str(row["ticket_id"]) for row in label_rows}) != len(label_rows):
        raise ValueError(f"{condition_dir.name}: duplicate test pseudo-label identity")
    labels = {str(row["ticket_id"]): int(row["label"]) for row in label_rows}
    train_labels = [int(row["label"]) for row in train_label_rows]
    test_label_values = list(labels.values())
    label_digest = _digest_ids(test_ids)
    cpu_path = cpu_results / f"{condition_dir.name}.json"
    cpu = json.loads(cpu_path.read_text(encoding="utf-8")) if cpu_path.exists() else None
    if cpu is not None and cpu.get("test_split_hash") != label_digest:
        raise ValueError(f"{condition_dir.name}: CPU result test identity does not match frozen labels")
    return {"condition_id": condition_dir.name, "manifest": manifest, "train_count": len(train_ids),
            "test_count": len(test_ids), "train_ids": train_ids, "test_ids": test_ids, "test_id_hash": label_digest,
            "label_count": len(labels), "label_complete": len(labels) == 128,
            "train_label_count": len(train_labels),
            "train_label_counts": {"negative": train_labels.count(0), "positive": train_labels.count(1)},
            "test_label_counts": {"negative": test_label_values.count(0), "positive": test_label_values.count(1)},
            "labels": labels, "cpu": cpu, "condition_dir": condition_dir}, manifest


def _prediction_map(records: list[dict[str, Any]], expected: set[str], method: str) -> dict[str, int]:
    found: dict[str, int] = {}
    for row in records:
        ticket_id = str(row["ticket_id"])
        if ticket_id in found:
            raise ValueError(f"{method}: duplicate prediction for {ticket_id}")
        if ticket_id not in expected:
            raise ValueError(f"{method}: prediction outside frozen test split: {ticket_id}")
        pred = int(row["prediction"])
        if pred not in (-1, 0, 1):
            raise ValueError(f"{method}: unsupported prediction {pred}")
        found[ticket_id] = pred
    if set(found) != expected:
        raise ValueError(f"{method}: prediction identities do not match all 128 frozen test tickets")
    return found


def _comparison(cases: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    aggregate: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        labels: dict[str, int] = case["labels"]
        expected = set(case["test_ids"])
        methods: dict[str, tuple[str, dict[str, int] | None, dict[str, Any] | None]] = {}
        cpu = case["cpu"]
        if cpu is not None:
            for item in cpu.get("methods", []):
                name, status = str(item["method"]), str(item.get("status", "unknown"))
                if status != "completed":
                    methods[name] = (status, None, {"error_type": item.get("error_type")})
                    continue
                preds = _prediction_map(item.get("predictions", []), expected, name)
                methods[name] = (status, preds, {"timing_seconds": item.get("timing_seconds"),
                    "threshold": item.get("threshold"), "config": item.get("config")})
        neural_root = case["condition_dir"] / "neural"
        for method in ("laya", "julia", "gliner"):
            path = neural_root / method / "predictions.jsonl"
            if not path.exists():
                continue
            records = read_jsonl(path)
            raw_path = neural_root / method / "environment.json"
            env = json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else {}
            if env.get("status") == "incomplete":
                names = ("gliner_official", "gliner_any_positive") if method == "gliner" else (method,)
                details = {"model": method, "completed_prediction_count": len(records),
                           "failure_type": env.get("failure_type"), "failure_message": env.get("failure_message"),
                           "truncated_input_rows": sum(bool(row.get("truncated")) for row in records)}
                for name in names:
                    methods[name] = ("incomplete", None, details)
                continue
            if method == "gliner":
                variants = (
                    ("gliner_official", "prediction", "score"),
                    ("gliner_any_positive", "prediction_any_chunk_relevant", "score_any_chunk_relevant"),
                )
            else:
                variants = ((method, "prediction", "score"),)
            for name, pred_key, score_key in variants:
                mapped_rows = [{**row, "prediction": row[pred_key]} for row in records]
                preds = _prediction_map(mapped_rows, expected, name)
                chunk_decisions = sum(int((row.get("length") or {}).get("chunk_count", 0)) for row in records)
                forward_batches = sum(math.ceil(int((row.get("length") or {}).get("chunk_count", 0)) / 8)
                                      for row in records) if method == "gliner" else len(records)
                if name == "gliner_any_positive":
                    details = {"model": method, "score_field": score_key,
                               "shared_inference_with": "gliner_official",
                               "truncated_input_rows": sum(bool(row.get("truncated")) for row in records)}
                else:
                    details = {"model": method, "score_field": score_key,
                        "input_tokens_total": env.get("input_tokens_total"),
                        "inference_seconds_total": env.get("inference_seconds_total"),
                        "model_calls": len(records), "forward_batches": forward_batches,
                        "chunk_decisions": chunk_decisions,
                        "truncated_input_rows": sum(bool(row.get("truncated")) for row in records)}
                methods[name] = ("completed", preds, details)
        if case["label_complete"]:
            methods["all_positive"] = ("completed", dict.fromkeys(case["test_ids"], 1),
                                        {"reference_only": True, "model_calls": 0})
            methods["all_negative"] = ("completed", dict.fromkeys(case["test_ids"], 0),
                                        {"reference_only": True, "model_calls": 0})
        all_names = set(methods) | set(METHODS) | {"laya", "julia", "gliner_official", "gliner_any_positive",
                                                     "all_positive", "all_negative"}
        for name in sorted(all_names):
            status, preds, details = methods.get(name, ("not_run", None, None))
            row: dict[str, Any] = {"condition_id": case["condition_id"], "method": name,
                "status": status, "test_count": len(labels), "test_id_hash": case["test_id_hash"],
                "reference_kind": "DS_V4.1_Flash_pseudo_labels_not_human_gold"}
            if preds is not None:
                ordered = case["test_ids"]
                row["prediction_count"] = len(preds)
                if case["label_complete"]:
                    y = [labels[ticket_id] for ticket_id in ordered]
                    p = [preds[ticket_id] for ticket_id in ordered]
                    metrics = score_binary(y, p)
                    row["metrics"] = metrics
                    row["predictions"] = [{"ticket_id": ticket_id, "prediction": preds[ticket_id],
                                            "pseudo_label": labels[ticket_id]} for ticket_id in ordered]
                    aggregate[name].append({"condition_id": case["condition_id"], "y": y, "p": p,
                                             "metrics": metrics, "details": details})
                else:
                    row["status"] = "predictions_complete_labels_incomplete"
                    row["label_count"] = case["label_count"]
            if details:
                row.update(details)
            rows.append(row)
    summaries: dict[str, Any] = {}
    methods = sorted({row["method"] for row in rows})
    for name in methods:
        observed = aggregate.get(name, [])
        if not observed:
            statuses = [row["status"] for row in rows if row["method"] == name]
            if not statuses or all(status == "not_run" for status in statuses):
                status = "not_run"
            elif "predictions_complete_labels_incomplete" in statuses:
                status = "labels_incomplete"
            elif "incomplete" in statuses:
                status = "incomplete"
            else:
                status = "failed"
            summaries[name] = {"status": status, "conditions_completed": 0,
                               "conditions_expected": len(cases), "test_examples": 0,
                               "incomplete_conditions": [{"condition_id": row["condition_id"],
                                   "completed_prediction_count": row.get("completed_prediction_count", 0),
                                   "failure_type": row.get("failure_type"),
                                   "failure_message": row.get("failure_message")}
                                   for row in rows if row["method"] == name and row["status"] == "incomplete"]}
            continue
        y = [value for run in observed for value in run["y"]]
        p = [value for run in observed for value in run["p"]]
        micro = score_binary(y, p)
        keys = ("precision", "recall", "f1", "accuracy", "balanced_accuracy", "coverage", "abstain_rate")
        macro = {key: (sum(run["metrics"][key] for run in observed if run["metrics"][key] is not None)
                       / sum(run["metrics"][key] is not None for run in observed))
                 if any(run["metrics"][key] is not None for run in observed) else None for key in keys}
        timings = [run["details"].get("timing_seconds") for run in observed if run["details"] and run["details"].get("timing_seconds")]
        neural = [run["details"] for run in observed if run["details"] and "input_tokens_total" in run["details"]]
        method_rows = [row for row in rows if row["method"] == name]
        incomplete = [{"condition_id": row["condition_id"],
                       "completed_prediction_count": row.get("completed_prediction_count", 0),
                       "failure_type": row.get("failure_type"), "failure_message": row.get("failure_message")}
                      for row in method_rows if row["status"] == "incomplete"]
        summaries[name] = {"status": "completed" if len(observed) == len(cases) else "partial",
            "conditions_completed": len(observed), "conditions_expected": len(cases), "test_examples": len(y),
            "micro": micro, "macro_by_condition": macro,
            "incomplete_conditions": incomplete,
            "truncated_input_rows": sum(int(row.get("truncated_input_rows", 0)) for row in method_rows),
            "timing_seconds_sum": {key: sum(float(v.get(key, 0)) for v in timings)
                                    for key in ("fit", "predict_and_score", "total")} if timings else None,
            "neural_usage_sum": {key: sum(float(v.get(key) or 0) for v in neural)
                                 for key in ("input_tokens_total", "inference_seconds_total", "model_calls",
                                             "forward_batches", "chunk_decisions")} if neural else None}
    return rows, summaries


def _report(cases: list[dict[str, Any]], rows: list[dict[str, Any]], summaries: dict[str, Any],
            common_comparable: dict[str, Any], identity_counts: dict[str, int]) -> str:
    eligible = {name: result for name, result in common_comparable.items()
                if result["comparable"] and name not in ("all_positive", "all_negative")}
    fmt = lambda x: f"{x:.3f}" if isinstance(x, (int, float)) else "—"
    best_bacc = max(eligible.items(), key=lambda pair: pair[1]["macro_by_condition"].get("balanced_accuracy", -1), default=None)
    best_f1 = max(eligible.items(), key=lambda pair: pair[1]["micro"].get("f1", -1), default=None)
    best_bacc_text = f"**{best_bacc[0]}（{fmt(best_bacc[1]['macro_by_condition']['balanced_accuracy'])}）**" if best_bacc else "尚无方法完成全部共同条件"
    best_f1_text = f"**{best_f1[0]}（{fmt(best_f1[1]['micro']['f1'])}）**" if best_f1 else "尚无方法完成全部共同条件"
    low_coverage = [(name, result["micro"].get("coverage")) for name, result in eligible.items()
                    if result["micro"].get("coverage") is not None and result["micro"]["coverage"] < 1]
    any_rows = [row for row in rows if row["method"] == "gliner_any_positive" and row.get("predictions")]
    any_total = sum(len(row["predictions"]) for row in any_rows)
    any_positive_count = sum(int(pred["prediction"] == 1) for row in any_rows for pred in row["predictions"])
    any_is_all_positive = any_total == 512 and any_positive_count == any_total
    lines = ["# 生产工单语义算子实验", "",
        "指标表示各方法与 DeepSeek V4.1 Flash 伪标签在冻结候选测试集上的一致程度，不是人工裁决准确率，也不代表全库召回率。", "",
        "## 结果解读", "",
        f"本报告的计数单位是问题—工单对；不同查询条件可能包含同一工单。四条件共有 {identity_counts['all_test_pairs']} 个测试问题—工单对，对应 {identity_counts['all_test_distinct_ticket_ids']} 个不同工单ID。",
        "每个查询条件独立切分并独立拟合模型；同一工单跨条件重复出现时属于不同问题—工单对，不跨条件共享训练或测试状态。",
        f"在 C01、Q01、Q02 三个可比较条件中，Macro Balanced accuracy 最高的是 {best_bacc_text}。Micro F1 最高的是 {best_f1_text}。该比较排除了 all-positive/all-negative 事后参照。",
        "C02 测试集没有负例，因此无法评估误报或特异度，也不进入共同 Balanced accuracy 比较。",
        ("低 coverage 方法的指标需结合覆盖率解读：" + ", ".join(f"{name} coverage={fmt(value)}" for name, value in low_coverage) + "。" if low_coverage else "共同可比较方法的 coverage 均为1.000。"),
        (f"GLiNER any-positive 在 {any_total} 条预测中将 {any_positive_count} 条判为相关，等同全正类参照，没有筛出负例；其分数不能解读为有效过滤能力。" if any_is_all_positive else "GLiNER any-positive 未在全部512条测试预测上退化为全正类判定。"),
        "下方先给出共同条件主表，再列四条件细项；共同条件结果计算口径固定为 C01、Q01、Q02，详情见表注。", "",
        "## 共同可比较条件（C01、Q01、Q02）", "",
        f"仅将三个测试集都完成、且每个测试集含正负伪标签的方法纳入；合并指标基于 {identity_counts['common_test_pairs']} 个问题—工单对（{identity_counts['common_test_distinct_ticket_ids']} 个不同工单ID），Macro为三个条件等权平均。C02测试集全为正例，单独展示而不进入Balanced accuracy。", "",
        "| 方法 | 完成条件 | 测试票数 | Micro F1 | Micro B.Acc | Macro F1 | Macro B.Acc |", "|---|---:|---:|---:|---:|---:|---:|"]
    for name, value in sorted(common_comparable.items()):
        micro, macro = value.get("micro", {}), value.get("macro_by_condition", {})
        status = f"{value['conditions_completed']}/3" if value["comparable"] else f"不比较（{value['conditions_completed']}/3）"
        lines.append(f"| {name} | {status} | {value.get('test_examples', 0)} | {fmt(micro.get('f1'))} | {fmt(micro.get('balanced_accuracy'))} | {fmt(macro.get('f1'))} | {fmt(macro.get('balanced_accuracy'))} |")
    lines += ["", "## 四个实验条件", "", "| 条件 | 查询 | 训练集 | 训练负/正 | 测试集 | 测试负/正 | 候选并集 | 向量模型 |", "|---|---|---:|---:|---:|---:|---:|---|"]
    for case in cases:
        manifest = case["manifest"]
        embedding = manifest.get("document_embedding", {})
        label_manifest_path = case["condition_dir"] / "label_manifest.json"
        label_manifest = json.loads(label_manifest_path.read_text(encoding="utf-8")) if label_manifest_path.exists() else {}
        embed_id = embedding.get("model", embedding.get("model_id", "unknown")) if isinstance(embedding, dict) else str(embedding or "unknown")
        train_counts, test_counts = case["train_label_counts"], case["test_label_counts"]
        lines.append(f"| {case['condition_id']} | {manifest.get('query', '')} | {case['train_count']} ({case['train_label_count']}已标) | "
                     f"{train_counts['negative']}/{train_counts['positive']} | {case['test_count']} ({case['label_count']}已标) | "
                     f"{test_counts['negative']}/{test_counts['positive']} | {manifest.get('recall_union_count', 'unknown')} | {embed_id} |")
    lines += ["", "## 各条件测试指标", "", "| 条件 | 方法 | 状态 | Precision | Recall | F1 | Accuracy | Balanced accuracy | Coverage |", "|---|---|---|---:|---:|---:|---:|---:|---:|"]
    for row in sorted(rows, key=lambda x: (x["condition_id"], x["method"])):
        m = row.get("metrics")
        values = [f"{m.get(key):.3f}" if m and isinstance(m.get(key), (int, float)) else "—"
                  for key in ("precision", "recall", "f1", "accuracy", "balanced_accuracy", "coverage")]
        lines.append(f"| {row['condition_id']} | {row['method']} | {row['status']} | " + " | ".join(values) + " |")
    lines += ["", "## 跨条件汇总", "", "Micro 汇总已完成条件的全部测试预测；Macro 对每个已完成条件等权平均。状态会显示方法完成的条件数。", "",
        "| 方法 | 状态 | 条件数 | 测试行 | Micro P | Micro R | Micro F1 | Micro B.Acc | Macro F1 | Macro B.Acc |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name, value in sorted(summaries.items()):
        micro, macro = value.get("micro", {}), value.get("macro_by_condition", {})
        fmt = lambda x: f"{x:.3f}" if isinstance(x, (int, float)) else "—"
        lines.append(f"| {name} | {value['status']} | {value.get('conditions_completed', 0)}/{value.get('conditions_expected', len(cases))} | "
            f"{value.get('test_examples', 0)} | {fmt(micro.get('precision'))} | {fmt(micro.get('recall'))} | {fmt(micro.get('f1'))} | "
            f"{fmt(micro.get('balanced_accuracy'))} | {fmt(macro.get('f1'))} | {fmt(macro.get('balanced_accuracy'))} |")
    lines += ["", "## 时间与用量", "", "向量生成、分类器拟合/推理和伪标签调用分别计量。metrics.json 的 `embedding_costs` 对共享的全量工单向量只计一次，查询向量按条件列出；伪标签用量保留在对应 label_manifest.json。神经模型 token、调用数和推理秒数汇总如下，逐条数据仍保留在 worker 的 environment.json 与 predictions.jsonl。CPU 的拟合和预测时间为已完成条件之和。", "",
        "| 方法 | CPU拟合秒 | CPU预测秒 | CPU合计秒 |", "|---|---:|---:|---:|"]
    for name, value in sorted(summaries.items()):
        timing = value.get("timing_seconds_sum")
        lines.append(f"| {name} | " + " | ".join(f"{timing[k]:.3f}" if timing else "—" for k in ("fit", "predict_and_score", "total")) + " |")
    lines += ["", "| 神经方法 | 条件数 | 工单调用 | 前向批次 | GLiNER分块判定 | 输入tokens | 推理秒数 | 截断输入行 |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for name, value in sorted(summaries.items()):
        usage = value.get("neural_usage_sum")
        if usage:
            lines.append(f"| {name} | {value['conditions_completed']} | {usage['model_calls']:.0f} | {usage['forward_batches']:.0f} | {usage['chunk_decisions']:.0f} | {usage['input_tokens_total']:.0f} | {usage['inference_seconds_total']:.3f} | {value.get('truncated_input_rows', 0)} |")
    lines += ["", "## 方法来源与固定配置", "",
        "| 方法 | 类型 | 来源或关系 | 固定配置 |", "|---|---|---|---|"]
    for name, (family, source, config) in METHOD_SCOPE.items():
        lines.append(f"| {name} | {family} | {source} | {config} |")
    lines += ["", "## 方法范围与限制", "",
        "- 所有方法共享按工单身份去重后的关键词 OR 向量召回候选并集；这里的分数不估计全库召回率。",
        "- 向量召回使用标题与摘要表示工单；神经分类器使用标题、摘要及工单原文。报告的共享向量成本只指本轮冻结的标题-摘要向量生成，不含此前已废弃的全字段尝试。",
        "- 监督方法只收到128条训练伪标签。测试伪标签只在确认预测身份完整匹配128条冻结测试工单后用于评分。",
        "- NameGMM 与 spherical K-means 只用无标签训练向量和查询锚点。反馈边界、原型、kNN、hard-negative、关系模型及 CPU 分类器使用训练伪标签。",
        "- Laya、Julia 为固定零样本本地模型。GLiNER 官方分块合并与 any-positive（任一块P(相关)≥0.5）规则共用一次模型推理；双类别exclusive分类使用softmax。",
        "- Laya 与 Julia 对超长正文使用模型自身的单次输入截断；每条预测记录并在汇总表报告截断行数。此类分数只代表实际进入模型的输入前缀。查询、业务边界与选项须完整通过预算检查。",
        "- GLiNER分块数表示按块得到的逐块判断；前向批次另计，当前每批最多8个块，二者不等同于HTTP请求数。GLiNER any-positive 与官方合并共用相同前向结果，推理成本只在官方合并行计一次。",
        "- Selective conformal 同时报告已回答样本指标和全测试指标；拒答的正例计为未召回，拒答不代表负判断。",
        "- all-positive 与 all-negative 是利用测试标签计算的事后朴素参照，不训练也不调用模型。它们用于解释类别比例，不是可部署方法。",
        "- 阅读 F1 时请同时查看 all-positive 参照和 Balanced accuracy：若方法 F1 接近 all-positive，且 Balanced accuracy 没有相应提升，可能主要受多数类比例驱动；不要只按 F1 排名。",
        "- 缺失运行记为 not_run，失败运行保留失败状态，不补造零分。教师标签是模型伪标签，不是人工真值。",
        f"- 每个条件只取混合检索排名靠前的256条并固定128/128切分，存在高排名抽样偏差；跨条件总计 {identity_counts['all_split_pairs']} 个问题—工单对、{identity_counts['all_split_distinct_ticket_ids']} 个不同工单ID。每类条件只有一个查询，跨4条件 Macro 结论范围有限。",
        "- 切分前只按规范化完整工单原文精确去重，没有按语义合并近重复工单；top-256候选结果不能外推为全库表现。",
        "- 这些比较用于方法筛选，不构成生产验收或对真实人工质量的结论。Laya 分块方案不纳入比较。", ""]
    return "\n".join(lines)


def build_report(conditions_root: Path, results_root: Path, output: Path) -> dict[str, Any]:
    condition_dirs = sorted(path for path in conditions_root.iterdir()
                            if path.is_dir() and (path / "manifest.json").exists())
    cases = [_load_condition(path, results_root)[0] for path in condition_dirs]
    rows, summaries = _comparison(cases)
    common_ids = ("C01", "Q01", "Q02")
    case_by_id = {case["condition_id"]: case for case in cases}
    common_cases = [case_by_id[cid] for cid in common_ids if cid in case_by_id]
    identity_counts = {
        "all_test_pairs": sum(case["test_count"] for case in cases),
        "all_test_distinct_ticket_ids": len({ticket for case in cases for ticket in case["test_ids"]}),
        "common_test_pairs": sum(case["test_count"] for case in common_cases),
        "common_test_distinct_ticket_ids": len({ticket for case in common_cases for ticket in case["test_ids"]}),
        "all_split_pairs": sum(case["train_count"] + case["test_count"] for case in cases),
        "all_split_distinct_ticket_ids": len({ticket for case in cases for ticket in case["train_ids"] + case["test_ids"]}),
    }
    common_methods: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["condition_id"] in common_ids and row.get("metrics") is not None:
            common_methods[row["method"]].append(row)
    common_comparable = {}
    for name in sorted(set(common_methods) | set(METHODS) | {"laya", "julia", "gliner_official", "gliner_any_positive", "all_positive", "all_negative"}):
        method_rows = common_methods.get(name, [])
        complete = len(method_rows) == 3 and all(case_by_id[cid]["label_complete"] for cid in common_ids)
        ys, ps, per_condition = [], [], []
        if complete:
            by_id = {row["condition_id"]: row for row in method_rows}
            for cid in common_ids:
                case = case_by_id[cid]
                pred_rows = by_id[cid]["predictions"]
                labels = case["labels"]
                y = [labels[t] for t in case["test_ids"]]
                pred_map = {str(v["ticket_id"]): int(v["prediction"]) for v in pred_rows}
                p = [pred_map[t] for t in case["test_ids"]]
                ys.extend(y); ps.extend(p)
                per_condition.append(score_binary(y, p))
        micro = score_binary(ys, ps) if complete else {}
        keys = ("precision", "recall", "f1", "accuracy", "balanced_accuracy", "coverage", "abstain_rate")
        macro = {key: (sum(m[key] for m in per_condition if m[key] is not None) /
                       sum(m[key] is not None for m in per_condition))
                 if any(m[key] is not None for m in per_condition) else None for key in keys}
        common_comparable[name] = {"comparable": complete, "conditions_expected": 3,
            "conditions_completed": len(method_rows), "condition_ids": [r["condition_id"] for r in method_rows],
            "test_examples": len(ys), "micro": micro, "macro_by_condition": macro}
    output.mkdir(parents=True, exist_ok=True)
    (output / "comparison.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    document_embeddings = {}
    query_identities = []
    document_generation = query_generation = None
    for case in cases:
        cpu = case["cpu"] or {}
        manifest = case["manifest"]
        document_identity = manifest.get("document_embedding") or cpu.get("embedding_identity")
        query_identity = manifest.get("query_embedding") or cpu.get("query_embedding_identity")
        generation = cpu.get("embedding_generation") or {}
        current_document_generation = generation.get("document") if isinstance(generation, dict) else generation
        current_query_generation = generation.get("query") if isinstance(generation, dict) else None
        identity_key = json.dumps(document_identity, ensure_ascii=False, sort_keys=True) if document_identity else case["condition_id"]
        document_embeddings.setdefault(identity_key, {"identity": document_identity, "generation": current_document_generation})
        if document_generation is None:
            document_generation = current_document_generation
        if query_generation is None:
            query_generation = current_query_generation
        query_identities.append({"condition_id": case["condition_id"], "identity": query_identity})
    metrics = {"condition_count": len(cases), "expected_conditions": 4,
        "conditions": [{"condition_id": case["condition_id"], "query": case["manifest"].get("query"),
                        "test_count": case["test_count"], "test_id_hash": case["test_id_hash"],
                        "pseudo_label_count": case["label_count"], "pseudo_labels_complete": case["label_complete"],
                        "train_pseudo_label_count": case["train_label_count"],
                        "train_pseudo_label_counts": case["train_label_counts"],
                        "test_pseudo_label_counts": case["test_label_counts"],
                        "document_embedding_identity": case["manifest"].get("document_embedding") or (case["cpu"] or {}).get("embedding_identity"),
                        "query_embedding_identity": case["manifest"].get("query_embedding") or (case["cpu"] or {}).get("query_embedding_identity")}
                       for case in cases],
        "embedding_costs": {"shared_document_embeddings": list(document_embeddings.values()),
                            "all_query_embeddings_generation": query_generation,
                            "query_embedding_identities_by_condition": query_identities},
        "methods": summaries, "common_comparable": common_comparable,
        "identity_counts": identity_counts,
        "reference_kind": "DS_V4.1_Flash_pseudo_labels_not_human_gold"}
    report_text = _report(cases, rows, summaries, common_comparable, identity_counts)
    (output / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "REPORT.md").write_text(report_text, encoding="utf-8")
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conditions-root", type=Path, required=True)
    parser.add_argument("--results-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_report(args.conditions_root, args.results_root, args.output), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
