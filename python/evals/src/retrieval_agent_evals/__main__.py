from __future__ import annotations

import argparse
import json
from pathlib import Path

from .models import EvalCase, ProductTrace
from .scorers import evaluate_trace


def main() -> int:
    parser = argparse.ArgumentParser(description="Score one exported Retrieval Agent trace")
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--trace", required=True, type=Path)
    args = parser.parse_args()
    case = EvalCase.from_mapping(json.loads(args.case.read_text(encoding="utf-8")))
    trace = ProductTrace.from_mapping(json.loads(args.trace.read_text(encoding="utf-8")))
    result = evaluate_trace(case, trace)
    print(json.dumps(result.to_mapping(), ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
