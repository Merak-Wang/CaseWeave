from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol


@dataclass(frozen=True)
class StartCaseParams:
    case_id: str
    user_message: str
    principal_fixture_id: str
    data_snapshot_id: str


@dataclass(frozen=True)
class StartCaseResponse:
    run_id: str
    session_id: str


@dataclass(frozen=True)
class ContinueCaseParams:
    run_id: str
    user_message: str


@dataclass(frozen=True)
class CancelCaseParams:
    run_id: str


@dataclass(frozen=True)
class ExportTraceParams:
    run_id: str


@dataclass(frozen=True)
class ExportTraceResponse:
    trace: Mapping[str, Any]


@dataclass(frozen=True)
class CaseTerminalNotification:
    run_id: str
    termination: str


class ProductTestDriver(Protocol):
    """External driver seam; implementations may not mutate product state directly."""

    def start(self, params: StartCaseParams) -> StartCaseResponse: ...

    def continue_case(self, params: ContinueCaseParams) -> None: ...

    def cancel(self, params: CancelCaseParams) -> None: ...

    def export_trace(self, params: ExportTraceParams) -> ExportTraceResponse: ...
