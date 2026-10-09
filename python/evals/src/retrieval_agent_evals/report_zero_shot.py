"""Score frozen zero-shot predictions against pseudo-labels and cached baselines."""
from __future__ import annotations
from .embedding_manifest import manifest_path as embedding_manifest_path

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from .binary_metrics import score_binary
from .experiment import read_jsonl


CONDITIONS = ("C01", "C02", "Q01", "Q02")
COMMON = ("C01", "Q01", "Q02")
BASELINES = ("laya", "julia", "gliner_official", "gliner_any_positive")


def _unique_predictions(rows: list[dict[str, Any]], expected: set[str], field: str) -> dict[str, int]:
    mapped = {}
    for row in rows:
        ticket_id = str(row["ticket_id"])
        if ticket_id in mapped or ticket_id not in expected:
            raise ValueError(f"{field}: duplicate or unexpected ticket id")
        mapped[ticket_id] = int(row["prediction"])
    if set(mapped) != expected:
        raise ValueError(f"{field}: test prediction identity mismatch")
    return mapped


def _cached_baselines(condition_dir: Path, expected: set[str]) -> dict[str, dict[str, int]]:
    output: dict[str, dict[str, int]] = {}
    neural = condition_dir / "neural"
    for model in ("laya", "julia", "gliner"):
        path = neural / model / "predictions.jsonl"
        if not path.exists():
            continue
        records = read_jsonl(path)
        if model == "gliner":
            output["gliner_official"] = _unique_predictions(
                [{**row, "prediction": row["prediction"]} for row in records], expected, model)
            output["gliner_any_positive"] = _unique_predictions(
                [{**row, "prediction": row["prediction_any_chunk_relevant"]} for row in records], expected,
                f"{model}/any-positive")
        else:
            output[model] = _unique_predictions(records, expected, model)
    return output


def _label_map(condition_dir: Path, expected: set[str]) -> dict[str, int]:
    rows = read_jsonl(condition_dir / "labeled.jsonl")
    labeled = {str(row["ticket_id"]): int(row["label"]) for row in rows
               if row.get("split") == "test" and row.get("label_source") == "deepseek-v4.1-flash"
               and row.get("label") in (0, 1)}
    if set(labeled) != expected:
        raise ValueError(f"{condition_dir.name}: test pseudo-label set does not match predictions")
    return labeled


def build_report(*, conditions_root: Path, predictions_root: Path,
                 protocol_path: Path, output_root: Path,
                 description_manifest_path: Path | None = None) -> dict[str, Any]:
    protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
    by_condition: dict[str, Any] = {}
    label_maps: dict[str, dict[str, int]] = {}
    prediction_maps: dict[str, dict[str, dict[str, int]]] = {}
    runtime_by_method: dict[str, float] = {}
    unique_ids_by_condition: dict[str, int] = {}
    for cid in CONDITIONS:
        condition_dir = conditions_root / cid
        candidate_rows = sorted((row for row in read_jsonl(condition_dir / "candidates.jsonl")
                                 if row["split"] == "test"), key=lambda row: str(row["ticket_id"]))
        ids = [str(row["ticket_id"]) for row in candidate_rows]
        expected = set(ids)
        labels = _label_map(condition_dir, expected)
        prediction_data = json.loads((predictions_root / f"{cid}.json").read_text(encoding="utf-8"))
        if prediction_data["protocol_sha256"] != hashlib.sha256(protocol_path.read_bytes()).hexdigest():
            raise ValueError(f"{cid}: predictions do not match frozen protocol")
        if prediction_data["candidate_sha256"] != hashlib.sha256((condition_dir / "candidates.jsonl").read_bytes()).hexdigest():
            raise ValueError(f"{cid}: candidate set changed after prediction")
        if prediction_data["test_count"] != 128:
            raise ValueError(f"{cid}: expected 128 zero-shot test predictions")
        test_hash = hashlib.sha256("\n".join(ids).encode()).hexdigest()
        if prediction_data["test_id_sha256"] != test_hash:
            raise ValueError(f"{cid}: test identity changed after prediction")
        expected_inputs = {str(row["ticket_id"]): hashlib.sha256(
            f"【标题】{row['title']}\n【摘要】{row['summary']}".encode("utf-8")).hexdigest()
            for row in candidate_rows}
        all_predictions: dict[str, dict[str, int]] = {}
        details = []
        for method in prediction_data["methods"]:
            name = method["method"]
            if any(row.get("input_sha256") != expected_inputs.get(str(row["ticket_id"]))
                   for row in method["predictions"]):
                raise ValueError(f"{cid}/{name}: input text hash mismatch")
            predictions = _unique_predictions(method["predictions"], expected, name)
            all_predictions[name] = predictions
            details.append({"method": name, "regime": method["regime"], "source": method["source"],
                            "learning_signal": method["learning_signal"], "config": method["config"],
                            "prediction_seconds": method["prediction_seconds"],
                            "metrics": score_binary([labels[ticket_id] for ticket_id in ids],
                                [predictions[ticket_id] for ticket_id in ids])})
            runtime_by_method[name] = runtime_by_method.get(name, 0.0) + float(method["prediction_seconds"])
        for name, predictions in _cached_baselines(condition_dir, expected).items():
            all_predictions[name] = predictions
            details.append({"method": name, "regime": "cached_zero_shot_baseline",
                            "source": f"existing {name} neural predictions", "learning_signal": "none",
                            "metrics": score_binary([labels[ticket_id] for ticket_id in ids],
                                [predictions[ticket_id] for ticket_id in ids])})
        all_predictions["all_positive"] = dict.fromkeys(ids, 1)
        all_predictions["all_negative"] = dict.fromkeys(ids, 0)
        for name, pred in (("all_positive", 1), ("all_negative", 0)):
            if name not in {row["method"] for row in details}:
                details.append({"method": name, "regime": "trivial_reference", "source": "constant test-only reference",
                                "learning_signal": "none", "metrics": score_binary(
                                    [labels[ticket_id] for ticket_id in ids], [pred] * len(ids))})
        by_condition[cid] = {"test_count": len(ids),
            "test_labels": {"negative": sum(value == 0 for value in labels.values()),
                            "positive": sum(value == 1 for value in labels.values())},
            "methods": sorted(details, key=lambda row: row["method"])}
        label_maps[cid] = labels
        prediction_maps[cid] = all_predictions
        unique_ids_by_condition[cid] = len(expected)

    common_names = set.intersection(*(set(prediction_maps[cid]) for cid in COMMON))
    common_metrics = {}
    for name in sorted(common_names):
        common_labels: list[int] = []
        common_predictions: list[int] = []
        per_condition = {}
        for cid in COMMON:
            condition_ids = sorted(prediction_maps[cid][name])
            y = [label_maps[cid][ticket_id] for ticket_id in condition_ids]
            p = [prediction_maps[cid][name][ticket_id] for ticket_id in condition_ids]
            per_condition[cid] = score_binary(y, p)
            common_labels.extend(y)
            common_predictions.extend(p)
        common_metrics[name] = {
            "micro": score_binary(common_labels, common_predictions),
            "macro_f1": sum(per_condition[cid]["f1"] for cid in COMMON) / len(COMMON),
            "macro_balanced_accuracy": (sum(per_condition[cid]["balanced_accuracy"] for cid in COMMON
                 if per_condition[cid]["balanced_accuracy"] is not None) /
                 sum(per_condition[cid]["balanced_accuracy"] is not None for cid in COMMON)),
            "per_condition": per_condition,
        }

    common_ids = set().union(*(set(label_maps[cid]) for cid in COMMON))
    all_test_ids = set().union(*(set(label_maps[cid]) for cid in CONDITIONS))
    description_manifest_path = description_manifest_path or embedding_manifest_path(protocol_path.parent / "description_embeddings.npz", legacy=True)
    if description_manifest_path.exists():
        description_manifest = json.loads(description_manifest_path.read_text(encoding="utf-8"))
        description_embedding = {key: description_manifest.get(key) for key in
                                 ("http_physical_requests", "provider_elapsed_ms", "wall_elapsed_seconds", "chunk_count")
                                 if key in description_manifest}
        description_embedding["embedding_sha256"] = description_manifest.get("embedding_sha256")
    else:
        description_embedding = None

    result = {"title": "Zero-shot methods against frozen pseudo-labels",
        "reference_kind": "DS_V4.1_Flash_pseudo_labels_not_human_gold",
        "candidate_scope": "fixed retrieved candidate pool; not full-corpus recall",
        "protocol_sha256": hashlib.sha256(protocol_path.read_bytes()).hexdigest(),
        "description_source": "frozen business definitions, not labeled tickets",
        "description_texts": protocol["class_descriptions"],
        "common_conditions": list(COMMON), "conditions": by_condition,
        "test_identity_counts": {"all_condition_rows": sum(unique_ids_by_condition.values()),
            "all_distinct_tickets": len(all_test_ids), "common_condition_rows": sum(unique_ids_by_condition[cid] for cid in COMMON),
            "common_distinct_tickets": len(common_ids)},
        "common_micro_metrics": common_metrics,
        "method_prediction_seconds": runtime_by_method,
        "zero_shot_execution_seconds_total": sum(runtime_by_method.values()),
        "description_embedding": description_embedding,
        "cached_baseline_calls_this_run": 0,
        "limits": ["分数衡量与DS V4.1 Flash伪标签的一致性，不是人工真值。",
                   "C02测试集没有负伪标签，无法估计负类质量。",
                   "Common比较仅汇总C01、Q01、Q02；C02单独展示。",
                   "新方法的工单向量只使用标题和摘要；缓存的Laya、Julia、GLiNER沿用原神经输入流程，输入字段不同。",
                   "这是已看过上一轮结果的同一固定测试集上的追加探索，不是新盲测；未用本轮分数调参。",
                   "K=2批次聚类会拆成两个簇，但不保证业务集合实际上同时含正类与负类。"]}
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_root / "REPORT.md").write_text(render_markdown(result), encoding="utf-8")
    return result


def render_markdown(result: dict[str, Any]) -> str:
    methods = sorted(result["common_micro_metrics"])
    counts = result["test_identity_counts"]
    new_methods = set(result["method_prediction_seconds"])
    best_macro_ba = max(new_methods, key=lambda name: result["common_micro_metrics"][name]["macro_balanced_accuracy"])
    best_micro_f1 = max(new_methods, key=lambda name: result["common_micro_metrics"][name]["micro"]["f1"])
    def display(name: str) -> str:
        return {"name_gmm_test_batch": "NameGMM",
                "spherical_kmeans_test_batch": "SphericalKMeans",
                "dual_description_margin": "双描述原型"}.get(name, name)
    dual_f1 = result["common_micro_metrics"]["dual_description_margin"]["micro"]["f1"]
    laya_f1 = result["common_micro_metrics"]["laya"]["micro"]["f1"]
    lines = ["# 零样本方法：冻结测试集伪标签一致性", "",
        f"本轮在原固定测试集上追加8种零样本方法，没有重跑Mongo、教师标注或神经基线，也没有根据本轮分数调参。四条件共{counts['all_condition_rows']}条测试记录、{counts['all_distinct_tickets']}个不同工单；common C01/Q01/Q02共{counts['common_condition_rows']}条条件记录、{counts['common_distinct_tickets']}个不同工单。预测先按冻结协议完成，随后评分器才读取DS V4.1 Flash伪标签。所有分数是与teacher伪标签的一致性，不是人工相关性真值。", "",
        f"在三个common条件的伪标签比较中，{display(best_macro_ba)}的macro balanced accuracy最高（{result['common_micro_metrics'][best_macro_ba]['macro_balanced_accuracy']:.3f}），{display(best_micro_f1)}的新方法micro F1最高（{result['common_micro_metrics'][best_micro_f1]['micro']['f1']:.3f}）。逐票双描述原型的micro F1为{dual_f1:.3f}，缓存LAYA为{laya_f1:.3f}。", "",
        f"八种新增方法四条件执行耗时合计{result['zero_shot_execution_seconds_total']:.3f}秒（含批次拟合与预测，不含NPZ读取或共享向量生成）。common三题按{counts['common_condition_rows']}条条件记录计算micro，并同时给出三个条件等权macro F1与macro balanced accuracy。重复出现在不同条件中的工单按不同查询判断分别计入micro。C02单独列示，其测试集没有负伪标签，因此负类质量无法评估。", ""]
    groups = [
        ("zero_example_independent", "逐票独立零样本", "每条工单只与冻结的正负描述向量比较，不读取同批其他工单。"),
        ("zero_label_transductive_batch", "无标签测试批次适配", "每个条件单独用固定128条test向量形成批次结构，不读取标签。"),
        ("cached_baseline", "缓存基线与常量参考", "复用既有Laya/Julia/GLiNER预测，不产生新基线调用。"),
    ]
    regime_labels = {"zero_example_independent": "逐票独立零样本",
                     "zero_label_transductive_batch": "无标签测试批次适配",
                     "cached_zero_shot_baseline": "缓存神经基线", "trivial_reference": "常量参考"}
    for group, label, explanation in groups:
        names = [name for name in methods if
                 ((group == "cached_baseline" and name not in result["method_prediction_seconds"]) or
                  (group != "cached_baseline" and any(row["method"] == name and row["regime"] == group
                    for cid in COMMON for row in result["conditions"][cid]["methods"]))) ]
        lines.extend([f"## 共同比较：{label}", "", explanation, "",
            "| 方法 | Micro F1 | Micro precision | Micro recall | Macro F1 | Macro balanced accuracy | 四条件合计耗时（秒） |",
            "|---|---:|---:|---:|---:|---:|---:|"])
        for name in names:
            item = result["common_micro_metrics"][name]
            micro = item["micro"]
            macro_ba = item["macro_balanced_accuracy"]
            duration = result["method_prediction_seconds"].get(name)
            duration_text = f"{duration:.3f}" if duration is not None else "缓存，0次新调用"
            precision = "n/a" if micro["precision"] is None else f"{micro['precision']:.3f}"
            recall = "n/a" if micro["recall"] is None else f"{micro['recall']:.3f}"
            lines.append(f"| {name} | {micro['f1']:.3f} | {precision} | {recall} | {item['macro_f1']:.3f} | {macro_ba:.3f} | {duration_text} |")
        lines.append("")
    lines.extend(["## 四个条件的完整结果", "",
        "方法耗时是每种新方法在四个条件的执行时间总和，包含batch拟合与预测，不含NPZ读取和共享向量生成；描述向量生成另行计量。缓存基线不重算，其本轮调用成本为0。", ""])
    for cid, condition in result["conditions"].items():
        counts = condition["test_labels"]
        lines.extend([f"### {cid}（{counts['positive']}条正伪标签，{counts['negative']}条负伪标签）", "",
            "| 方法 | 方法组 | F1 | Precision | Recall | Balanced accuracy | 预测耗时（秒） |", "|---|---|---:|---:|---:|---:|---:|"])
        for row in condition["methods"]:
            m = row["metrics"]
            ba = "n/a" if m["balanced_accuracy"] is None else f"{m['balanced_accuracy']:.3f}"
            duration = f"{row['prediction_seconds']:.3f}" if "prediction_seconds" in row else "缓存，0次新调用"
            recall = "n/a" if m["recall"] is None else f"{m['recall']:.3f}"
            lines.append(f"| {row['method']} | {regime_labels.get(row['regime'], row['regime'])} | {m['f1']:.3f} | {m['precision']:.3f} | {recall} | {ba} | {duration} |")
        lines.append("")
    embedding = result["description_embedding"]
    if embedding is None:
        embedding_cost = "描述向量生成成本未记录。"
    else:
        calls = embedding.get("http_physical_requests", "未记录")
        elapsed = embedding.get("provider_elapsed_ms")
        elapsed_text = f"{elapsed:.2f} ms" if isinstance(elapsed, (int, float)) else "未记录"
        embedding_cost = f"描述向量本轮记录了{calls}次Embedding请求，provider耗时{elapsed_text}。"
    lines.extend(["## 冻结的正负描述", "",
        f"以下描述从已冻结的业务查询边界整理，不是根据已标注工单反推。逐票独立方法使用这些描述的固定向量。{embedding_cost}既有query和20k工单向量复用，不属于本轮新生成成本。", ""])
    for row in result["description_texts"]:
        lines.append(f"- **{row['condition_id']}**: {row['query']}")
    lines.extend(["", "## 限制", ""] + [f"- {item}" for item in result["limits"]] + [""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conditions-root", type=Path, default=Path(".cache/evals/production-v1/conditions"))
    parser.add_argument("--predictions-root", type=Path, default=Path(".cache/evals/production-v1/zero-shot/predictions"))
    parser.add_argument("--protocol", type=Path, default=Path(".cache/evals/production-v1/zero-shot/protocol.json"))
    parser.add_argument("--output-root", type=Path, default=Path(".cache/evals/production-v1/zero-shot"))
    parser.add_argument("--description-manifest", type=Path)
    args = parser.parse_args()
    result = build_report(conditions_root=args.conditions_root, predictions_root=args.predictions_root,
                          protocol_path=args.protocol, output_root=args.output_root,
                          description_manifest_path=args.description_manifest)
    print(json.dumps({"conditions": len(result["conditions"]), "output": str(args.output_root)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
