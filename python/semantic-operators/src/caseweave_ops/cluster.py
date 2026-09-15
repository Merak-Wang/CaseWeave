"""CSV sampling/voting and a separately checked CaseWeave variant.

Only row positions, normalized features and reference labels live here. Text,
Wiki, transport, persistence and task generations belong to the adapters.
No NxN similarities, task quotas, or proxy labels used as training targets.
"""
from collections import deque
from dataclasses import dataclass
import math
import numpy as np
from scipy.stats import hypergeom
from sklearn.cluster import KMeans, MiniBatchKMeans
from sklearn.linear_model import LogisticRegression
from threadpoolctl import threadpool_limits


@dataclass(frozen=True)
class FilterOptions:
    clusters: int = 4
    pilot_size: int = 12
    block_size: int = 2048
    proposal: str = "similarity"
    seed: int = 0
    # Reference-disagreement tolerances, NOT business quality guarantees.
    # Zero by default. Nonzero values require a deployment quality decision.
    accept_error: float = 0.0
    reject_error: float = 0.0
    delta: float = 0.01
    validation_size: int | None = None
    sample_ratio: float = 0.1
    vote_lower: float = 0.1
    vote_upper: float = 0.9

    def __post_init__(self):
        if self.proposal not in {"uniform", "similarity", "linear"}:
            raise ValueError("Unknown proposal")
        if min(self.clusters, self.pilot_size, self.block_size) < 1:
            raise ValueError("Sizes must be positive")
        if not (0 <= self.accept_error < 1 and 0 <= self.reject_error < 1 and 0 < self.delta < 1):
            raise ValueError("Invalid disagreement parameters")
        if not (0 < self.sample_ratio <= 1 and 0 <= self.vote_lower < self.vote_upper <= 1):
            raise ValueError("Invalid CSV parameters")
        if self.validation_size is not None and self.validation_size < 1:
            raise ValueError("Validation sample must be positive")


def remaining_error_upper(total, sampled, errors, alpha):
    """Exact one-sided finite-population inversion, minus observed errors."""
    lo, hi = errors, errors + total - sampled
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if hypergeom.logcdf(errors, total, mid, sampled) >= math.log(alpha):
            lo = mid
        else:
            hi = mid - 1
    return lo - errors


def check_size(total, tolerance, alpha):
    """Choose sample size BEFORE observing labels; enough to pass at zero errors.

    Zero tolerance typically reads nearly the entire region. A small sample
    cannot establish absence of a rare contrary label in a finite population.
    """
    lo, hi = 1, total
    while lo < hi:
        n = (lo + hi) // 2
        if remaining_error_upper(total, n, 0, alpha) <= tolerance * (total - n):
            hi = n
        else:
            lo = n + 1
    return lo


def partition(X, ids, count, rng, block_size, *, csv=False):
    """Fit on bounded feature blocks; only the small CSV comparison uses KMeans."""
    if len(ids) < 2 or count == 1:
        return [ids]
    count = min(count, len(ids))
    if csv:
        assignments = KMeans(n_clusters=count, n_init=10,
                             random_state=int(rng.integers(2**31 - 1))).fit_predict(X[ids])
    else:
        model = MiniBatchKMeans(n_clusters=count, n_init=3, reassignment_ratio=0,
                                random_state=int(rng.integers(2**31 - 1)), batch_size=max(count, block_size))
        # Random order avoids a first contiguous block setting every centroid.
        order = rng.permutation(ids)
        width = max(count, block_size)
        for start in range(0, len(order), width):
            block = order[start:start + width]
            if len(block) >= count:
                model.partial_fit(X[block])
        assignments = np.empty(len(ids), dtype=np.int32)
        for start in range(0, len(ids), block_size):
            assignments[start:start + block_size] = model.predict(X[ids[start:start + block_size]])
    return [ids[assignments == k] for k in np.unique(assignments)]


def vote(X, train, target, labels, method, block_size):
    """Fit/predict on strong labels, or UniVote / shifted-cosine SimVote.

    Both target AND training axes are blocked: no target x all-feedback matrix.
    Linear training keeps a bounded uniform subset of the existing labels.
    """
    y = labels[train]
    if method == "uniform" or np.unique(y).size == 1:
        return np.full(len(target), y.mean()), False
    if method == "linear":
        model = LogisticRegression(C=1, max_iter=300)
        model.fit(X[train], y)
        output = np.empty(len(target))
        for start in range(0, len(target), block_size):
            output[start:start + block_size] = model.predict_proba(X[target[start:start + block_size]])[:, 1]
        return output, True
    output = np.empty(len(target))
    for start in range(0, len(target), block_size):
        block = X[target[start:start + block_size]]
        numerator, denominator = np.zeros(len(block)), np.zeros(len(block))
        for at in range(0, len(train), block_size):
            part = train[at:at + block_size]
            weights = np.maximum(0, (block @ X[part].T + 1) / 2)
            numerator += weights @ labels[part]
            denominator += weights.sum(axis=1)
        output[start:start + len(block)] = np.divide(numerator, denominator,
            out=np.full(len(block), y.mean()), where=denominator > 1e-12)
    return output, False


async def cluster_filter(X, judge, *, options=None, known=None, method="cluster"):
    """Yield (row ids, labels, basis, phase/check).

    judge is an async iterator so every actual model batch can be delivered
    immediately. -2=unasked, -1=Unknown. Every visit consumes unasked rows;
    no depth, calls, tokens or elapsed-time cutoff is needed for termination.
    CSV uses Algorithm 1's cross-cluster unresolved pooling and KMeans;
    CaseWeave uses MiniBatchKMeans, local splitting and independent checks.
    """
    cfg = options or FilterOptions()
    labels = np.full(len(X), -2, dtype=np.int8)
    proxy = np.zeros(len(X), dtype=bool)
    for i, y in (known or {}).items():
        labels[i] = y
    rng = np.random.default_rng(cfg.seed)
    tests = 0

    async def ask(ids, phase):
        pending = ids[labels[ids] == -2]
        async for part, values in judge(pending, phase):
            labels[part] = values
            yield part, values, "reference", {"phase": phase}

    def split(ids, count):
        with threadpool_limits(limits=1):
            return partition(X, ids, count, rng, cfg.block_size, csv=method == "csv")

    queue = deque(split(np.arange(len(X)), cfg.clusters)) if len(X) else deque()
    while queue:
        unresolved = []
        for _ in range(len(queue)):
            group = queue.popleft()
            pending = group[labels[group] == -2]
            if not len(pending):
                continue
            size = max(cfg.pilot_size, int(len(pending) * cfg.sample_ratio)) if method == "csv" else cfg.pilot_size
            # Reuse same-predicate strong labels before buying new training data.
            train = group[(labels[group] >= 0) & ~proxy[group]]
            count = min(len(pending), max(0, size - len(train)))
            pilot = rng.choice(pending, count, replace=False)
            async for event in ask(pilot, "pilot"):
                yield event
            train = group[(labels[group] >= 0) & ~proxy[group]]
            pending = group[labels[group] == -2]
            if not len(pending):
                continue
            if not len(train):
                async for event in ask(pending, "fallback"):
                    yield event
                continue
            # Memory bound on the linear fit, sampled only from genuine labels.
            if cfg.proposal == "linear" and len(train) > cfg.block_size:
                train = rng.choice(train, cfg.block_size, replace=False)
            with threadpool_limits(limits=1):
                scores, fitted = vote(X, train, pending, labels, cfg.proposal, cfg.block_size)
            yield np.array([], dtype=int), np.array([], dtype=int), "observation", {
                "phase": "prediction", "model_fits": int(fitted), "training": train.tolist(),
                "predicted_count": len(pending), "method": cfg.proposal}
            if method == "csv":
                for value, mask in ((0, scores <= cfg.vote_lower), (1, scores >= cfg.vote_upper)):
                    ids = pending[mask]
                    labels[ids], proxy[ids] = value, True
                    if len(ids):
                        yield ids, labels[ids], "proxy", {"phase": "csv_vote", "method": cfg.proposal}
                unresolved.append(pending[labels[pending] == -2])
                continue
            # Freeze both predicted regions before seeing any calibration labels.
            for value in (0, 1):
                region = pending[(scores >= 0.5) == bool(value)]
                if not len(region):
                    continue
                tests += 1
                alpha = cfg.delta / (tests * (tests + 1))
                tolerance = cfg.accept_error if value else cfg.reject_error
                n = min(len(region), cfg.validation_size or check_size(len(region), tolerance, alpha))
                validation = rng.choice(region, n, replace=False)
                async for event in ask(validation, "calibration"):
                    yield event
                remainder = region[labels[region] == -2]
                errors = int(np.count_nonzero(labels[validation] != value))
                upper = remaining_error_upper(len(region), n, errors, alpha)
                check = {"phase": "check", "population": len(region), "sampled": n,
                         "errors": errors, "remaining": len(remainder), "error_upper": upper,
                         "alpha": alpha, "tolerance": tolerance, "proposed": value,
                         "inferred": bool(len(remainder) and upper <= tolerance * len(remainder))}
                yield np.array([], dtype=int), np.array([], dtype=int), "observation", check
                if check["inferred"]:
                    labels[remainder], proxy[remainder] = value, True
                    yield remainder, labels[remainder], "proxy", check
                elif len(remainder):
                    children = split(remainder, 2)
                    if len(children) == 1:
                        async for event in ask(remainder, "fallback"):
                            yield event
                    else:
                        queue.extend(children)
        if method == "csv" and unresolved:
            ids = np.concatenate(unresolved)
            if len(ids):
                children = split(ids, cfg.clusters)
                if len(children) == 1:
                    async for event in ask(ids, "fallback"):
                        yield event
                else:
                    queue.extend(children)
