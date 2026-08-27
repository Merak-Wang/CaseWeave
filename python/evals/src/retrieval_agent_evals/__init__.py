"""External, deterministic Retrieval Agent evaluation primitives."""

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
]
