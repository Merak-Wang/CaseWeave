"""提供可替换的低成本评分；分数既不是概率，也不是最终业务判断。"""
from __future__ import annotations
import math
import unicodedata
from dataclasses import asdict
from typing import Protocol
import numpy as np
from .types import Decision, Record, Scoring, digest


def unit(v) -> np.ndarray:
    # 统一转为有限的一维单位向量，后续点积才能直接表示余弦相似度。
    a = np.asarray(v, dtype=np.float64)
    if a.ndim != 1 or a.size == 0 or not np.all(np.isfinite(a)):
        raise ValueError("Expected a finite, nonempty real vector")
    n = np.linalg.norm(a)
    if n <= 1e-12:
        raise ValueError("Zero vector is not an embedding")
    return a / n


def matrix(record: Record, embedding_id: str, dimension: int) -> np.ndarray | None:
    if not record.vectors:
        return None
    # 不同模型或版本的向量空间不可直接比较，维度相同也不能放宽此约束。
    if record.embedding_id != embedding_id:
        raise ValueError("Embedding spaces must match")
    rows = [unit(v) for v in record.vectors]
    if any(len(v) != dimension for v in rows):
        raise ValueError("Embedding dimensions must match")
    return np.vstack(rows)


def norm_text(text: str) -> str:
    return unicodedata.normalize("NFKC", text).lower()


class FeedbackSet:
    def __init__(self, predicate_key: str):
        self.predicate_key = predicate_key
        self.samples: dict[str, tuple[Record, int]] = {}
        self.revoked: set[str] = set()
        self.decisions: dict[str, Decision] = {}

    def observe(self, record: Record, decision: Decision) -> None:
        # 判据和记录版本必须完全一致，防止旧反馈污染新查询或新正文。
        if decision.predicate_key != self.predicate_key or decision.record_identity != record.identity:
            raise ValueError("Feedback belongs to another predicate or source version")
        # 只吸收有真实模型证据的标签，代理推断和传输失败结果不得自我训练。
        # 未决会撤销同 ref 的旧样本，避免继续使用已经失去依据的标签。
        if decision.label == "undetermined":
            self.revoke(record.ref)
            return
        if decision.basis not in ("model", "reused_model"):
            self.samples.pop(record.ref, None)
            self.decisions.pop(record.ref, None)
            return
        if not decision.citations:
            raise ValueError("Feedback requires an admitted actual-source reference")
        self.samples[record.ref] = (record, int(decision.label == "accept"))
        self.decisions[record.ref] = decision
        self.revoked.discard(record.ref)

    def revoke(self, ref: str) -> None:
        self.samples.pop(ref, None)
        self.decisions.pop(ref, None)
        self.revoked.add(ref)

    @property
    def fingerprint(self) -> str:
        # 指纹覆盖记录版本、标签和向量空间，反馈变化会自动使已训练模型失效。
        return digest([self.predicate_key, [(ref, r.identity, y, r.vectors, r.embedding_id)
                       for ref, (r, y) in sorted(self.samples.items())]])


class WeakScorer(Protocol):
    @property
    def fingerprint(self) -> str: ...
    def score(self, record: Record) -> Scoring: ...


class MultiViewScorer:
    """组合原始/改写查询向量、字面线索和本地已标注邻居。

    两条记录间的相似度取已提供段落的最大值，它只是一种召回特征，不能证明
    时间或业务关系。宿主必须提供同空间的真实向量，不使用伪造或哈希向量兜底。
    """
    def __init__(self, queries, embedding_id: str, keywords: list[str], feedback: FeedbackSet,
                 *, k: int = 5, temperature: float = 0.15):
        if not queries or k < 1 or temperature <= 0:
            raise ValueError("Query vectors, positive k and temperature are required")
        self.queries = np.vstack([unit(q) for q in queries])
        self.embedding_id, self.feedback = embedding_id, feedback
        self.keywords = sorted({norm_text(k).strip() for k in keywords if k.strip()})
        self.k, self.temperature = k, temperature

    @property
    def fingerprint(self) -> str:
        return digest(["multiview-knn-v1", self.queries.tolist(), self.embedding_id,
                       self.keywords, self.k, self.temperature, self.feedback.fingerprint])

    def score(self, record: Record) -> Scoring:
        # 基础分同时考虑最相似查询向量和关键词覆盖，缺向量时仍可保留字面信号。
        a = matrix(record, self.embedding_id, self.queries.shape[1])
        text = norm_text("\n".join(p.text for p in record.passages))
        lex = sum(k in text for k in self.keywords) / len(self.keywords) if self.keywords else 0.0
        base = float(np.max(a @ self.queries.T)) if a is not None else 0.0
        neighbours: list[tuple[float, str, int]] = []
        if a is not None:
            # 从已核验反馈中寻找同空间近邻，但排除记录自身以免虚增支持度。
            for ref, (r, label) in self.feedback.samples.items():
                if ref == record.ref:
                    continue
                b = matrix(r, self.embedding_id, a.shape[1])
                if b is not None:
                    neighbours.append((float(np.max(a @ b.T)), ref, label))
        neighbours.sort(key=lambda n: (-n[0], n[1]))
        neighbours = neighbours[:self.k]
        local = nearest = None
        conflict = 0.0
        if neighbours:
            # 以最近邻为数值基准做温度加权，并用二项方差形态表达局部冲突度。
            nearest = neighbours[0][0]
            weights = np.exp((np.array([s for s, _, _ in neighbours]) - nearest) / self.temperature)
            local = float(weights @ np.array([y for _, _, y in neighbours]) / weights.sum())
            conflict = 4 * local * (1 - local)
        # 权重只决定处理优先级，不是经过校准的自动纳入或排除阈值。
        priority = 0.75 * (base + 1) / 2 + 0.25 * lex
        if local is not None:
            priority = 0.8 * priority + 0.2 * local
        return Scoring(priority, local, len(neighbours), nearest, conflict, self.fingerprint)


def rocchio(query, positive, negative, alpha=1.0, beta=0.6, gamma=0.2):
    """仅作查询扩展基线；每次从原始 q0 重算，不递归累计重复样本。"""
    q = unit(query)
    def mean(rows):
        if not rows:
            return np.zeros_like(q)
        m = np.vstack([unit(v) for v in rows])
        if m.shape[1] != q.size:
            raise ValueError("Mismatched dimensions")
        return m.mean(axis=0)
    # 向正样本质心靠近、远离负样本质心；退化为零向量时保留原始查询。
    value = alpha*q + beta*mean(positive) - gamma*mean(negative)
    return q if np.linalg.norm(value) <= 1e-12 else unit(value)


class LinearFeedbackScorer:
    """基于同一批反馈的可选对照评分器，不是启动查询的前置条件。

    特征由平均向量和字符 2～5 gram TF-IDF 组成；平均向量可能丢失局部边界，
    因此只能与 MultiViewScorer 对照验证，不能预设它更优。
    """
    def __init__(self, base: MultiViewScorer):
        self.base, self.fitted = base, False
        self._fit_hash: str | None = None

    def fit(self) -> bool:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        from scipy.sparse import csr_matrix, hstack
        # 训练必须同时具备正负两类真实反馈；条件不足时明确保持未拟合状态。
        rows = [(r, y) for r, y in self.base.feedback.samples.values() if r.vectors]
        if len({y for _, y in rows}) < 2:
            self.fitted = False
            return False
        self.vectorizer = TfidfVectorizer(analyzer="char", ngram_range=(2, 5), sublinear_tf=True)
        texts = ["\n".join(p.text for p in r.passages) for r, _ in rows]
        try:
            sparse = self.vectorizer.fit_transform(texts)
        except ValueError:
            self.fitted = False
            return False
        # 拼接字符稀疏特征和记录平均向量，让字面模式与语义方向共同参与拟合。
        dense = np.vstack([matrix(r, self.base.embedding_id, self.base.queries.shape[1]).mean(axis=0) for r, _ in rows])
        self.classifier = LogisticRegression(C=1.0, max_iter=500, random_state=0)
        self.classifier.fit(hstack([sparse, csr_matrix(dense)]), [y for _, y in rows])
        self._fit_hash, self.fitted = self.base.feedback.fingerprint, True
        return True

    @property
    def fingerprint(self) -> str:
        return digest(["linear-feedback-v1", self._fit_hash, self.base.fingerprint])

    def score(self, record: Record) -> Scoring:
        from scipy.sparse import csr_matrix, hstack
        initial = self.base.score(record)
        # 反馈集合变化、尚未拟合或记录无向量时退回基础排序，不复用陈旧分类器。
        if not self.fitted or self._fit_hash != self.base.feedback.fingerprint or not record.vectors:
            return Scoring(initial.priority, None, 0, None, 0.0, self.fingerprint)
        dense = matrix(record, self.base.embedding_id, self.base.queries.shape[1]).mean(axis=0)[None, :]
        sparse = self.vectorizer.transform(["\n".join(p.text for p in record.passages)])
        score = float(self.classifier.predict_proba(hstack([sparse, csr_matrix(dense)]))[0, 1])
        return Scoring(0.5*initial.priority + 0.5*score, score,
                       len(self.base.feedback.samples), None, 4*score*(1-score), self.fingerprint)
