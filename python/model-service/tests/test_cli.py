from __future__ import annotations

from pathlib import Path

from retrieval_agent_model_service import cli


class FakeBackend:
    def __init__(
        self,
        manifest: object,
        embedding_path: Path,
        reranker_path: Path | None,
        enable_reranker: bool,
        device: str,
    ) -> None:
        del manifest, embedding_path, reranker_path, enable_reranker, device

    def load(self) -> None:
        return None


def test_keyboard_interrupt_stops_without_a_traceback(
    monkeypatch: object, capsys: object, tmp_path: Path
) -> None:
    manifest_path = tmp_path / "manifest.json"
    embedding_path = tmp_path / "embedding"
    monkeypatch.setattr(cli, "load_manifest", lambda _: object())
    monkeypatch.setattr(cli, "QwenModelBackend", FakeBackend)
    monkeypatch.setattr(
        cli,
        "serve",
        lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    monkeypatch.setattr(
        "sys.argv",
        [
            "retrieval-agent-model-service",
            "--manifest",
            str(manifest_path),
            "--embedding-path",
            str(embedding_path),
        ],
    )

    cli.main()

    output = capsys.readouterr().out
    assert "model service ready" in output
    assert "model service stopped" in output
