from __future__ import annotations

import math
import os
import threading
import time
from pathlib import Path
from typing import Any

from .errors import ServiceError
from .manifest import RetrievalModelManifest, verify_weights
from .query_analysis import SpacyQueryAnalyzer


class QwenModelBackend:
    def __init__(
        self,
        manifest: RetrievalModelManifest,
        embedding_path: Path,
        reranker_path: Path | None,
        spacy_path: Path,
        domain_lexicon_path: Path | None,
        enable_reranker: bool,
        device_name: str,
        max_batch_size: int = 16,
        max_total_tokens: int = 8192,
        max_rerank_candidates: int = 20,
    ) -> None:
        self.manifest = manifest
        self.embedding_path = embedding_path.resolve()
        self.reranker_path = reranker_path.resolve() if reranker_path else None
        self.query_analyzer = SpacyQueryAnalyzer(spacy_path, domain_lexicon_path)
        self.enable_reranker = enable_reranker
        self.device_name = device_name
        self.max_batch_size = max_batch_size
        self.max_total_tokens = max_total_tokens
        self.max_rerank_candidates = max_rerank_candidates
        self._gate = threading.BoundedSemaphore(1)
        self._priority_lock = threading.Lock()
        self._interactive_waiters = 0
        self._embedding_tokenizer: Any = None
        self._embedding_model: Any = None
        self._reranker_tokenizer: Any = None
        self._reranker_model: Any = None
        self._torch: Any = None
        self.device = "unloaded"
        self.dtype = "unloaded"

    def load(self) -> None:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        try:
            import torch
            from transformers import AutoModel, AutoModelForCausalLM, AutoTokenizer
        except ImportError as error:
            raise ServiceError(500, "RUNTIME_MISSING", "Install the model-service runtime dependency group.") from error
        self._torch = torch
        self.query_analyzer.load()
        verify_weights(self.embedding_path, self.manifest.embedding.weight_sha256)
        if self.enable_reranker:
            if self.reranker_path is None:
                raise ServiceError(500, "MODEL_FILES_MISSING", "Reranker is enabled without a model path.")
            verify_weights(self.reranker_path, self.manifest.reranker.weight_sha256)
        if self.device_name == "auto":
            self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        else:
            self.device = self.device_name
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            raise ServiceError(500, "GPU_UNAVAILABLE", "CUDA was explicitly requested but is unavailable; check Docker GPU access/driver or select the CPU configuration.")
        dtype = torch.bfloat16 if self.device.startswith("cuda") and torch.cuda.is_bf16_supported() else (
            torch.float16 if self.device.startswith("cuda") else torch.float32
        )
        self._embedding_tokenizer = AutoTokenizer.from_pretrained(
            self.embedding_path, local_files_only=True, padding_side="left"
        )
        self._embedding_model = AutoModel.from_pretrained(
            self.embedding_path, local_files_only=True, dtype=dtype
        ).to(self.device).eval()
        self.dtype = str(next(self._embedding_model.parameters()).dtype).replace("torch.", "")
        if self.enable_reranker:
            self._reranker_tokenizer = AutoTokenizer.from_pretrained(
                self.reranker_path, local_files_only=True, padding_side="left"
            )
            self._reranker_model = AutoModelForCausalLM.from_pretrained(
                self.reranker_path, local_files_only=True, dtype=dtype
            ).to(self.device).eval()
            reranker_dtype = str(next(self._reranker_model.parameters()).dtype).replace("torch.", "")
            if reranker_dtype != self.dtype:
                raise ServiceError(500, "MODEL_DTYPE_MISMATCH", "Embedding and reranker dtype differ.")
        self.embed(["warmup"], "document", None, self.manifest.embedding.dimensions or 1024)
        if self.enable_reranker:
            self.rerank("warmup", [{"id": "warmup", "text": "warmup"}], self.manifest.reranker.instruction or "", 1)

    def descriptors(self) -> list[dict[str, Any]]:
        result = [{
            "model": self.manifest.embedding.model,
            "revision": self.manifest.embedding.revision,
            "kind": "embedding",
            "loaded": self._embedding_model is not None,
            "dtype": self.dtype,
            "device": self.device,
            "maxTokens": self.manifest.embedding.max_tokens,
            "dimensions": self.manifest.embedding.dimensions,
            "pooling": self.manifest.embedding.pooling,
            "normalization": self.manifest.embedding.normalization,
        }]
        if self.enable_reranker:
            result.append({
                "model": self.manifest.reranker.model,
                "revision": self.manifest.reranker.revision,
                "kind": "reranker",
                "loaded": self._reranker_model is not None,
                "dtype": self.dtype,
                "device": self.device,
                "maxTokens": self.manifest.reranker.max_tokens,
                "scoreKind": self.manifest.reranker.score_kind,
            })
        return result

    def query_analysis_descriptor(self) -> dict[str, Any]:
        return self.query_analyzer.descriptor()

    def analyze_query(self, query: str) -> dict[str, Any]:
        return self.query_analyzer.analyze(query)

    def _acquire(self) -> None:
        if not self._gate.acquire(blocking=False):
            raise ServiceError(429, "BACKPRESSURE", "The model service is busy.", retryable=True)

    def _tokens(self, tokenizer: Any, texts: list[str], max_tokens: int) -> None:
        # Cap every row deterministically at the versioned model budget. The
        # aggregate check still bounds batch attention memory.
        encoded = tokenizer(
            texts, add_special_tokens=True, padding=False, truncation=True, max_length=max_tokens
        )
        lengths = [len(row) for row in encoded["input_ids"]]
        if sum(lengths) > self.max_total_tokens:
            raise ServiceError(413, "TOKEN_LIMIT", "Model input exceeds the configured token budget.")

    def embed_measured(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int,
                       timings: dict[str, float], cancel: threading.Event, complete: bool) -> list[list[float]]:
        queued = time.perf_counter()
        interactive = input_type == "query"
        with self._priority_lock:
            self._interactive_waiters += int(interactive)
        acquired = False
        try:
            while not acquired:
                if cancel.is_set():
                    raise ServiceError(499, "CANCELLED", "Embedding cancelled before computation.")
                if time.perf_counter() - queued > 120:
                    raise ServiceError(429, "BACKPRESSURE", "Embedding queue capacity exceeded.", retryable=True)
                with self._priority_lock:
                    priority_waiting = self._interactive_waiters > 0
                if not interactive and priority_waiting:
                    cancel.wait(0.01)
                    continue
                acquired = self._gate.acquire(timeout=0.025)
                if acquired and not interactive:
                    with self._priority_lock:
                        priority_waiting = self._interactive_waiters > 0
                    if priority_waiting:
                        self._gate.release()
                        acquired = False
            timings["queueMs"] = (time.perf_counter() - queued) * 1000
            if cancel.is_set():
                raise ServiceError(499, "CANCELLED", "Embedding cancelled before computation.")
            started = time.perf_counter()
            try:
                return self.embed(texts, input_type, instruction, dimensions, complete=complete, gate_owned=True)
            finally:
                timings["computeMs"] = (time.perf_counter() - started) * 1000
        finally:
            with self._priority_lock:
                self._interactive_waiters -= int(interactive)
            if acquired:
                self._gate.release()

    def embed(self, texts: list[str], input_type: str, instruction: str | None, dimensions: int,
              complete: bool = False, gate_owned: bool = False) -> list[list[float]]:
        if self._embedding_model is None:
            raise ServiceError(503, "NOT_READY", "Embedding model is not ready.", retryable=True)
        if len(texts) < 1 or len(texts) > self.max_batch_size or any(not text.strip() for text in texts):
            raise ServiceError(400, "INVALID_REQUEST", "Embedding input batch is invalid.")
        if dimensions != self.manifest.embedding.dimensions:
            raise ServiceError(400, "DIMENSION_MISMATCH", "Only the manifest embedding dimensions are supported.")
        prompt = instruction or self.manifest.embedding.instruction or ""
        prepared = [f"Instruct: {prompt}\nQuery:{text}" for text in texts] if input_type == "query" else texts
        if not gate_owned:
            self._acquire()
        try:
            if complete:
                encoded = self._embedding_tokenizer(prepared, add_special_tokens=True, padding=False, truncation=False)
                if any(len(row) > self.manifest.embedding.max_tokens for row in encoded["input_ids"]):
                    raise ServiceError(413, "INPUT_TRUNCATION_REQUIRED", "Split source fields before embedding; complete input exceeds model token capacity.")
            self._tokens(self._embedding_tokenizer, prepared, self.manifest.embedding.max_tokens)
            batch = self._embedding_tokenizer(
                prepared, padding=True, truncation=True, max_length=self.manifest.embedding.max_tokens,
                return_tensors="pt",
            ).to(self.device)
            with self._torch.inference_mode():
                output = self._embedding_model(**batch, use_cache=False)
                hidden = output.last_hidden_state
                # Qwen3-Embedding is configured for left padding, so every row's
                # final position is the final non-padding token. Keep the fallback
                # for a future tokenizer whose padding side changes.
                if bool((batch["attention_mask"][:, -1] == 1).all()):
                    pooled = hidden[:, -1]
                else:
                    sequence_lengths = batch["attention_mask"].sum(dim=1) - 1
                    rows = self._torch.arange(hidden.shape[0], device=hidden.device)
                    pooled = hidden[rows, sequence_lengths]
                normalized = self._torch.nn.functional.normalize(pooled, p=2, dim=1)
            vectors = normalized.float().cpu().tolist()
            if any(len(vector) != dimensions or not all(math.isfinite(value) for value in vector) for vector in vectors):
                raise ServiceError(500, "INVALID_VECTOR", "Embedding model produced invalid vectors.")
            return vectors
        finally:
            if not gate_owned:
                self._gate.release()

    def rerank(self, query: str, candidates: list[dict[str, str]], instruction: str, top_k: int) -> list[dict[str, Any]]:
        if self._reranker_model is None:
            raise ServiceError(503, "NOT_READY", "Reranker model is not ready.", retryable=True)
        if (
            not query.strip()
            or not candidates
            or len(candidates) > self.max_rerank_candidates
            or not isinstance(top_k, int)
            or top_k < 1
            or top_k > len(candidates)
        ):
            raise ServiceError(400, "INVALID_REQUEST", "Reranker input is invalid.")
        self._acquire()
        try:
            tokenizer = self._reranker_tokenizer
            prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
            suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
            prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False)
            suffix_tokens = tokenizer.encode(suffix, add_special_tokens=False)
            pairs = [f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {item['text']}" for item in candidates]
            encoded = tokenizer(
                pairs, padding=False, truncation="longest_first", add_special_tokens=False,
                max_length=self.manifest.reranker.max_tokens - len(prefix_tokens) - len(suffix_tokens),
                return_attention_mask=False,
            )
            encoded["input_ids"] = [prefix_tokens + row + suffix_tokens for row in encoded["input_ids"]]
            if sum(len(row) for row in encoded["input_ids"]) > self.max_total_tokens:
                raise ServiceError(413, "TOKEN_LIMIT", "Reranker input exceeds the configured token budget.")
            batch = tokenizer.pad(encoded, padding=True, return_tensors="pt").to(self.device)
            true_id = tokenizer.convert_tokens_to_ids("yes")
            false_id = tokenizer.convert_tokens_to_ids("no")
            with self._torch.inference_mode():
                logits = self._reranker_model(
                    **batch, use_cache=False, logits_to_keep=1
                ).logits[:, -1, :]
                binary = self._torch.stack([logits[:, false_id], logits[:, true_id]], dim=1)
                scores = self._torch.softmax(binary, dim=1)[:, 1].float().cpu().tolist()
        finally:
            self._gate.release()
        result = [
            {"id": item["id"], "inputIndex": index, "score": float(scores[index])}
            for index, item in enumerate(candidates)
        ]
        result.sort(key=lambda item: (-item["score"], item["inputIndex"], item["id"]))
        result = result[:top_k]
        for rank, item in enumerate(result, start=1):
            item["rank"] = rank
        return result
