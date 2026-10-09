from retrieval_agent_evals.embedding_worker import DOCUMENT_FIELDS, _document_text


def test_document_embedding_material_uses_title_and_summary_only():
    row = {"title": "员工权限异常", "summary": "工号没有菜单授权", "body": "敏感长对话不得送入embedding"}
    assert DOCUMENT_FIELDS == ["title", "summary"]
    assert _document_text(row) == "【标题】员工权限异常\n【摘要】工号没有菜单授权"


def test_same_stem_embedding_preserves_download_manifest(tmp_path):
    import json
    from retrieval_agent_evals.embedding_manifest import manifest_path, write_manifest
    dataset = tmp_path / "tickets.jsonl"
    dataset.write_text('{"ticket_id":"t1"}\n', encoding="utf-8")
    download = dataset.with_suffix(".manifest.json")
    original = '{"query":{"center":"运保中心"},"records":1}'
    download.write_text(original, encoding="utf-8")
    output = dataset.with_suffix(".npz")
    assert manifest_path(output, legacy=True) == download
    write_manifest(output, {"embedding": {"model": "fixture"}})
    assert download.read_text(encoding="utf-8") == original
    assert manifest_path(output, legacy=True).name == "tickets.embedding.manifest.json"
    assert json.loads(manifest_path(output).read_text(encoding="utf-8"))["embedding"]["model"] == "fixture"
