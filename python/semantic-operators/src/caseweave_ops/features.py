"""数值数据面：对齐整数 ID 与连续稠密/CSR 块，正文另按抽样 ID 读取。"""
from dataclasses import dataclass
import base64
import numpy as np
from scipy.sparse import csr_matrix


@dataclass
class FeatureBlock:
    ids: np.ndarray
    dense: np.ndarray
    available: np.ndarray
    sparse: csr_matrix | None = None
    scores: np.ndarray | None = None

    @property
    def views(self):
        return {"dense": self.dense, **({"sparse": self.sparse} if self.sparse is not None else {})}


def decode_array(value, dtype):
    return np.frombuffer(base64.b64decode(value), dtype=dtype)


def decode_block(page):
    ids = np.asarray(page["ids"], dtype=np.int64)
    dense = decode_array(page["dense"], "<f4").reshape(len(ids), page["dimensions"])
    sparse = page.get("sparse")
    matrix = None if sparse is None else csr_matrix((decode_array(sparse["data"], "<f4"),
        decode_array(sparse["indices"], "<i4"), decode_array(sparse["indptr"], "<i4")),
        shape=(len(ids), sparse["columns"]))
    return FeatureBlock(ids, dense, decode_array(page["available"], "u1").astype(bool), matrix,
        np.asarray(page["scores"], dtype=np.float64) if "scores" in page else None)


def memmap_blocks(ids_path, dense_path, shape, *, block_size=16384, available_path=None):
    """本机近数据部署可直接扫描只读映射，不复制完整矩阵。"""
    ids = np.memmap(ids_path, dtype="<i8", mode="r", shape=(shape[0],))
    dense = np.memmap(dense_path, dtype="<f4", mode="r", shape=shape)
    available = np.memmap(available_path, dtype="u1", mode="r", shape=(shape[0],)) if available_path else None
    for start in range(0, shape[0], block_size):
        end = min(shape[0], start + block_size)
        yield FeatureBlock(ids[start:end], dense[start:end], np.ones(end-start, dtype=bool)
                           if available is None else available[start:end].astype(bool))


def random_keys(ids, seed):
    """每 ID 固定伪随机键；块宽改变不会改变抽样，也不占用全库随机数组。"""
    with np.errstate(over="ignore"):
        x = np.asarray(ids, dtype=np.uint64) + np.uint64(seed) + np.uint64(0x9e3779b97f4a7c15)
        x = (x ^ (x >> 30)) * np.uint64(0xbf58476d1ce4e5b9)
        x = (x ^ (x >> 27)) * np.uint64(0x94d049bb133111eb)
        x ^= x >> 31
    return (x >> 11).astype(np.float64) / 2**53


class PrioritySample:
    """Keep largest priorities for disjoint incoming IDs.

    IID continuous random priorities give a uniform sample without replacement.
    Other priorities are for LEARNING, never for a population-quality estimate.
    """
    def __init__(self, size):
        if size < 1:
            raise ValueError("Sample size must be positive")
        self.size = size
        self.ids = np.empty(0, dtype=np.int64)
        self.keys = np.empty(0, dtype=np.float64)
        self.seen = 0

    def add(self, ids, keys):
        ids, keys = np.asarray(ids, dtype=np.int64), np.asarray(keys, dtype=np.float64)
        self.seen += len(ids)
        ids, keys = np.r_[self.ids, ids], np.r_[self.keys, keys]
        # 同分固定按 ID 排序，分页宽度不会改变有界候选池。
        keep = np.lexsort((ids, -keys))[:self.size]
        self.ids, self.keys = ids[keep], keys[keep]
