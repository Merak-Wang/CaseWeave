"""External, deterministic CaseWeave evaluation primitives."""

from .models import EvalCase, ProductTrace
from .scorers import EvaluationResult, ScoredCheck, evaluate_trace

__all__ = [
    "EvalCase",
    "EvaluationResult",
    "ProductTrace",
    "ScoredCheck",
    "evaluate_trace",
]
