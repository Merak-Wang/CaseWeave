import json
from types import SimpleNamespace

from retrieval_agent_evals.jeff_worker import (_fit_state_prefix, _jeff_material,
                                              _jeff_question, _prompts, _selected_test)


class CharTokenizer:
    def encode(self, text, add_special_tokens=False):
        return list(text)

    def decode(self, tokens, skip_special_tokens=False, clean_up_tokenization_spaces=False):
        return "".join(tokens)


def test_jeff_selection_uses_only_test_text_and_keeps_laya_material_shape(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({
        "condition_id": "C01", "query": "完整查询", "labeling_guidance": "业务边界"}), encoding="utf-8")
    rows = [{"ticket_id": f"T{i}", "split": "test" if i >= 128 else "train",
             "title": "标题", "summary": "摘要", "body": "正文",
             "label": i % 2, "label_source": "teacher"} for i in range(256)]
    (tmp_path / "candidates.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")

    selected, manifest = _selected_test(tmp_path)

    assert len(selected) == 128
    assert set(selected[0]) == {"ticket_id", "title", "summary", "body"}
    assert _jeff_material(selected[0]) == "[标题] 标题\n[摘要] 摘要"
    assert "正文" not in _jeff_material(selected[0])
    prompt = _prompts(manifest)["relevant"]
    assert "完整查询" in prompt["instructions"]
    assert "业务边界" in prompt["instructions"]
    assert list(prompt["criteria"]) == ["A", "B"]
    jeff_prompt = _jeff_question(manifest)
    assert "本次工单材料仅包含标题和摘要" in jeff_prompt["instructions"]
    assert "以原文为准" not in jeff_prompt["instructions"]
    assert "完整查询" in jeff_prompt["instructions"]


def test_state_budget_truncates_only_prefix_tail_and_preserves_full_question():
    tokenizer = CharTokenizer()
    model = SimpleNamespace(processor=SimpleNamespace(tokenizer=tokenizer))
    question = {"type": "choice", "instructions": "全部边界必须保留",
                "criteria": {"A": "相关", "B": "不相关"}}
    observed = []

    def count_prompt(state, actual_question, _model):
        observed.append(actual_question)
        rendered = f"固定模板:{actual_question['instructions']}:{state}"
        return rendered, rendered, 20 + len(state)

    state = "工单前缀" * 30
    result = _fit_state_prefix(state, question, model, count_prompt, max_prompt_tokens=100)

    assert result["state_truncated"] is True
    assert result["state"].startswith(state[:len(result["state"])])
    assert result["input_tokens"] <= 100
    assert result["state_original_tokens"] == len(state)
    assert result["state_used_tokens"] == len(result["state"])
    assert all(actual_question is question for actual_question in observed)


def test_short_state_is_left_unchanged():
    tokenizer = CharTokenizer()
    model = SimpleNamespace(processor=SimpleNamespace(tokenizer=tokenizer))
    result = _fit_state_prefix("short", {}, model,
                               lambda state, question, _model: (state, [1], len(state)))
    assert result["state"] == "short"
    assert result["state_truncated"] is False
    assert result["input_tokens"] == 5
