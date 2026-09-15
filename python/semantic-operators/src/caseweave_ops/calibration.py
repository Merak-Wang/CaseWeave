"""对预先冻结的有限预测区域执行可选的内部验收检验。

它不是公开管理工具，也不能证明全局业务召回率。阈值必须在均匀抽取留出样本前
确定；校准调用照常计量，默认逐条强判断也不依赖此证书。
"""
from __future__ import annotations
import math
import random
from fractions import Fraction
from dataclasses import dataclass
from typing import Literal
from .types import Decision, Record, Scoring, digest


def _zero_probability(N: int, errors: int, n: int) -> float:
    if n > N-errors:
        return 0.0
    # 用对数累加计算零次命中概率，降低大量连乘造成的数值下溢。
    return math.exp(sum(math.log1p(-errors/(N-i)) for i in range(n)))


def error_upper_bound(N: int, n: int, observed_errors: int, alpha: float) -> int:
    """计算无放回简单随机抽样下，错误总数的单侧超几何置信上界。

    只有观察到错误时才依赖 scipy；空值和未决判断必须按错误计入，不能从样本量
    中静默剔除。
    """
    if not (0 < n <= N and 0 <= observed_errors <= n and 0 < alpha < 1):
        raise ValueError("Invalid finite-population calibration parameters")
    if n == N:
        return observed_errors
    def cdf(M: int) -> float:
        if observed_errors == 0:
            return _zero_probability(N, M, n)
        from scipy.stats import hypergeom
        return float(hypergeom.cdf(observed_errors, N, M, n))
    def is_admissible(M: int) -> bool:
        if N <= 256:
            # 小总体使用整数排列组合和有理数阈值，避免浮点误差收窄上界。
            target = Fraction(str(alpha))
            numerator = sum(math.comb(M,k)*math.comb(N-M,n-k)
                for k in range(observed_errors+1) if 0<=k<=M and 0<=n-k<=N-M)
            return numerator*target.denominator >= math.comb(N,n)*target.numerator
        # 数值相等附近按保守方向放宽上界；这是数值保护，不是形式化证明。
        value = cdf(M)
        return value >= alpha or math.isclose(value, alpha, rel_tol=1e-12, abs_tol=0.0)
    # 可接受性随假设错误总数单调变化，用二分找到仍满足置信条件的最大值。
    lo, hi = observed_errors, N-n+observed_errors
    while lo < hi:
        mid = (lo+hi+1)//2
        if is_admissible(mid):
            lo = mid
        else:
            hi = mid-1
    return lo


@dataclass(frozen=True)
class FrozenRegion:
    predicate_key: str
    scorer_id: str
    label: Literal["accept", "exclude"]
    member_ids: tuple[str, ...]
    sample_ids: tuple[str, ...]
    error_tolerance: float
    alpha: float

    @classmethod
    def sample(cls, predicate_key: str, scorer_id: str, label: Literal["accept", "exclude"],
               member_ids: list[str], fitting_ids: set[str], n: int,
               error_tolerance: float, alpha: float = 0.05,
               rng: random.Random | None = None) -> FrozenRegion:
        if label not in ("accept", "exclude") or not 0 <= error_tolerance < 1 or not 0 < alpha < 1:
            raise ValueError("Invalid calibration target")
        members = tuple(sorted(member_ids))
        if len(members) != len(set(members)) or set(members) & fitting_ids or not 0 < n <= len(members):
            raise ValueError("Frozen region must be unique, exclude fitting records and have a valid sample size")
        # 必须先冻结完整区域再随机抽样，禁止看过标签后只挑方便的前缀。
        chosen = tuple((rng or random.SystemRandom()).sample(list(members), n))
        return cls(predicate_key, scorer_id, label, members, chosen, error_tolerance, alpha)

    def evaluate(self, judgments: dict[str, str], calibration_id: str) -> RegionGate | None:
        if set(judgments) != set(self.sample_ids):
            raise ValueError("Every preselected holdout result must be present, including unknowns")
        if any(v not in ("accept", "exclude", "undetermined") for v in judgments.values()):
            raise ValueError("Invalid calibration judgment")
        # 与目标标签不一致的结果全部算错，undetermined 也不能逃避校准惩罚。
        errors = sum(v != self.label for v in judgments.values())
        upper = error_upper_bound(len(self.member_ids), len(self.sample_ids), errors, self.alpha)
        # 只有总体错误率上界不超过预设容忍度，才签发可复用的区域门证书。
        if upper / len(self.member_ids) > self.error_tolerance:
            return None
        return RegionGate(self.predicate_key, self.scorer_id, self.label,
                          frozenset(self.member_ids), upper, self.alpha, calibration_id)


@dataclass(frozen=True)
class RegionGate:
    predicate_key: str
    scorer_id: str
    label: Literal["accept", "exclude"]
    member_ids: frozenset[str]
    errors_upper: int
    alpha: float
    calibration_id: str

    @property
    def id(self) -> str:
        return digest([self.predicate_key, self.scorer_id, self.label, sorted(self.member_ids),
                       self.errors_upper, self.alpha, self.calibration_id])

    def apply(self, record: Record, scoring: Scoring, predicate_key: str) -> Decision | None:
        # 判据、评分器版本和冻结成员身份必须同时命中，防止证书跨版本套用。
        if predicate_key != self.predicate_key or scoring.scorer_id != self.scorer_id or record.identity not in self.member_ids:
            return None
        return Decision(record.ref, record.identity, predicate_key, self.label, basis="proxy",
                        reason="Frozen-region proxy inference; not per-record LLM verification", proxy_attestation=self.id)
