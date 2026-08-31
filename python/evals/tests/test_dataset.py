from retrieval_agent_evals.dataset import load_legacy_bronze_cases, verify_legacy_bronze_manifest


def test_legacy_bronze_manifest_and_cases_are_reproducible() -> None:
    manifest = verify_legacy_bronze_manifest()
    cases = load_legacy_bronze_cases()

    assert manifest["labelMaturity"] == "bronze"
    assert len(cases) == 162
    assert {case.split for case in cases} == {"train", "dev", "test"}
    assert manifest["splitCounts"] == {"train": 113, "dev": 28, "test": 21}
    assert any(not case.qrels for case in cases)
    assert {qrel.ticket_id for case in cases for qrel in case.qrels} == {
        f"TKT-{index:04d}" for index in range(1, 41)
    }
