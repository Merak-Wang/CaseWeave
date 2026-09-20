"""Finite-population set-quality bounds, NOT model confidence certificates.

Assumptions: fixed population & predictions; simple random sample per disjoint
region; truthful determinate teacher labels; the model did not use audit labels.
Unknown observations are conservatively bounded, not silently excluded.
For repeated new audits allocate delta_t=delta/[t(t+1)] or another valid schedule.
"""
from dataclasses import dataclass
import math
from scipy.stats import hypergeom


@dataclass
class Region:
    selected: bool
    population: int
    sampled: int
    positives: int
    unknown: int = 0


def positive_bounds(N, n, k, alpha):
    """Two-sided exact hypergeometric inversion for total positives K."""
    if not 0 <= k <= n <= N or not 0 < alpha < 1:
        raise ValueError("Require 0 <= k <= n <= N and 0 < alpha < 1")
    if n == 0:
        return 0, N
    if n == N:
        return k, k
    log_tail = math.log(alpha/2)
    lo, hi = k, k+N-n
    while lo < hi:
        mid = (lo+hi)//2
        if hypergeom.logsf(k-1, N, mid, n) >= log_tail:
            hi = mid
        else:
            lo = mid+1
    lower = lo
    lo, hi = k, k+N-n
    while lo < hi:
        mid = (lo+hi+1)//2
        if hypergeom.logcdf(k, N, mid, n) >= log_tail:
            lo = mid
        else:
            hi = mid-1
    return lower, lo


def quality_bounds(regions, *, known_tp=0, known_fp=0, known_fn=0, known_unknown=0, delta=.05):
    """Known counts refer ONLY to separately enumerated, genuinely labeled IDs.

    Excluded inspected unknowns go in known_unknown, never in exact negatives.
    Uncovered/missing-feature areas must be a rejected Region(N, 0, 0), or be
    independently sampled. Omitting them invalidates full-scope recall claims.
    """
    regions = list(regions)
    tp_lo = tp_hi = known_tp
    fn_lo, fn_hi = known_fn, known_fn + known_unknown
    returned = known_tp+known_fp
    intervals = []
    for region in regions:
        if not 0 <= region.positives+region.unknown <= region.sampled:
            raise ValueError("Invalid sample label counts")
        alpha = delta/max(1, len(regions))  # simultaneous region coverage
        low = positive_bounds(region.population, region.sampled, region.positives, alpha)[0]
        high = positive_bounds(region.population, region.sampled,
                               region.positives+region.unknown, alpha)[1]
        intervals.append((low, high))
        if region.selected:
            returned += region.population
            tp_lo += low; tp_hi += high
        else:
            fn_lo += low; fn_hi += high
    return {"precision_lower": tp_lo/returned if returned else None,
            "recall_lower": tp_lo/(tp_lo+fn_hi) if tp_lo+fn_hi else None,
            "tp_interval": (tp_lo, tp_hi), "fn_interval": (fn_lo, fn_hi),
            "returned": returned, "region_intervals": intervals, "delta": delta,
            "reference": "truthful audit labels; not an assumption that an LLM is business truth"}
