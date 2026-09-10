from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from threading import Thread

from .backend import QwenModelBackend
from .manifest import load_manifest
from .server import serve


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="CaseWeave local model service")
    result.add_argument("--manifest", type=Path, required=True)
    result.add_argument("--embedding-path", type=Path, required=True)
    result.add_argument("--reranker-path", type=Path)
    result.add_argument("--spacy-path", type=Path, required=True)
    result.add_argument("--domain-lexicon", type=Path)
    result.add_argument("--vector-cache-dir", type=Path)
    result.add_argument("--checkpoint-every-batches", type=int, default=8)
    result.add_argument("--enable-reranker", action="store_true")
    result.add_argument("--device", default="auto")
    result.add_argument("--host", default="127.0.0.1")
    result.add_argument("--allow-container-bind", action="store_true",
                        help="explicitly allow 0.0.0.0 inside a container; publish host port on loopback only")
    result.add_argument("--max-batch-size", type=int, default=16)
    result.add_argument("--max-total-tokens", type=int, default=8192)
    result.add_argument("--port", type=int, default=8012)
    result.add_argument(
        "--exit-on-stdin-close",
        action="store_true",
        help="exit when the supervising launcher's stdin pipe closes",
    )
    return result


def _exit_when_stdin_closes() -> None:
    try:
        sys.stdin.buffer.read()
    finally:
        os._exit(0)


def validate_bind(host: str, allow_container_bind: bool) -> None:
    if host not in ("127.0.0.1", "localhost", "::1") and not (host == "0.0.0.0" and allow_container_bind):
        raise SystemExit("model service requires loopback; container 0.0.0.0 requires --allow-container-bind")


def main() -> None:
    args = parser().parse_args()
    validate_bind(args.host, args.allow_container_bind)
    if args.checkpoint_every_batches < 1:
        raise SystemExit("checkpoint interval must be positive")
    if args.max_batch_size < 1 or args.max_total_tokens < 1:
        raise SystemExit("model resource limits must be positive")
    backend = QwenModelBackend(
        load_manifest(args.manifest), args.embedding_path, args.reranker_path,
        args.spacy_path, args.domain_lexicon,
        args.enable_reranker, args.device,
        max_batch_size=args.max_batch_size, max_total_tokens=args.max_total_tokens,
    )
    backend.load()
    if args.exit_on_stdin_close:
        Thread(target=_exit_when_stdin_closes, name="launcher-watchdog", daemon=True).start()
    print(f"retrieval-agent model service ready on http://{args.host}:{args.port}", flush=True)
    try:
        serve(backend, args.host, args.port, args.vector_cache_dir, args.checkpoint_every_batches)
    except KeyboardInterrupt:
        print("retrieval-agent model service stopped", flush=True)


if __name__ == "__main__":
    main()
