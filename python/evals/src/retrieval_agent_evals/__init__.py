"""External, deterministic Retrieval Agent evaluation primitives."""

from .dataset import BronzeCase, BronzeQrel, load_legacy_bronze_cases, verify_legacy_bronze_manifest
from .models import EvalCase, ProductTrace
from .scorers import EvaluationResult, ScoredCheck, evaluate_trace

__all__ = [
    "BronzeCase",
    "BronzeQrel",
    "EvalCase",
    "EvaluationResult",
    "ProductTrace",
    "ScoredCheck",
    "evaluate_trace",
    "load_legacy_bronze_cases",
    "verify_legacy_bronze_manifest",
]
