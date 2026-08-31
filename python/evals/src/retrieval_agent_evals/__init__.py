"""External, deterministic Retrieval Agent evaluation primitives."""

from .dataset import BronzeCase, BronzeQrel, load_legacy_bronze_cases, verify_legacy_bronze_manifest
from .models import EvalCase, ProductTrace
from .protocol import (
    CancelCaseParams,
    CaseTerminalNotification,
    ContinueCaseParams,
    ExportTraceParams,
    ExportTraceResponse,
    StartCaseParams,
    StartCaseResponse,
)
from .scorers import EvaluationResult, ScoredCheck, evaluate_trace

__all__ = [
    "BronzeCase",
    "BronzeQrel",
    "CancelCaseParams",
    "CaseTerminalNotification",
    "ContinueCaseParams",
    "EvalCase",
    "EvaluationResult",
    "ExportTraceParams",
    "ExportTraceResponse",
    "ProductTrace",
    "ScoredCheck",
    "StartCaseParams",
    "StartCaseResponse",
    "evaluate_trace",
    "load_legacy_bronze_cases",
    "verify_legacy_bronze_manifest",
]
