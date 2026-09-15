# CaseWeave Python semantic operators

Streaming semantic search, filtering, ranking, extraction, mapping, joins and
source-linked aggregation. The TypeScript host owns authorization, task state,
DSH model configuration, Provider access and result publication. Python results
must pass the host's evidence and input-revision checks before publication.

Run kernel tests from the workspace root with `pnpm operators:test`.
`pnpm operators:serve --port 8013` starts the persistent FastAPI service.
Set `CASEWEAVE_OPERATORS_URL=http://127.0.0.1:8013` in the Node host to use
its private `/v1/operators` WebSocket; `/health` reports readiness. An optional
`CASEWEAVE_OPERATORS_TOKEN` must match on both sides. Browser origins are rejected.
Without a service URL the host starts a persistent UTF-8 NDJSON worker.
DSH owns model credentials and the host owns Provider access and publication.

## Default filter

`dispatch.invoke_rows('sem_filter', ...)` runs the numerical kernel in
`cluster.py` through the disk/text adapter in `filter_adapter.py`:

1. Publish the first strong batch while ingesting authorized rows in pages.
2. Read existing features into a float32 memmap; keep text in temporary SQLite.
3. Group the entire supplied region with MiniBatchKMeans and sample within regions.
4. Judge samples through the existing DSH model route with source text and Wiki.
5. Predict remaining rows with UniVote, shifted-cosine SimVote, or an actually
   fitted local logistic classifier (`options.proposal='linear'`).
6. Freeze each predicted population, draw an independent sample, and invert a
   finite-population hypergeometric bound. Infer only its uncalled remainder if
   the check passes; otherwise split or judge the unresolved remainder directly.

Strong counterexamples retain their labels. Unknown is unresolved, never a
negative training label. Proxies never train the next prediction. Current
host-authorized strong feedback overrides older cached labels; user revisions
change the task namespace. The host rejects stale output and publishes valid
proxies with `basis='proxy'`, without a fictitious per-row model request.

Production disagreement tolerances default to **zero**, with `delta=.01` across
checks. This usually requires nearly a census, can increase batch request count,
and does not prove business correctness or global search recall. Nonzero
tolerances in the benchmark are explicit experiments, not production defaults.
Missing features use strong judgment; the operator never re-embeds the corpus.

## Comparisons and other operators

- `algorithm='reference'`: preserved batch/filter baseline; supplying `queries`
  enables its original within-batch feedback sort. All rows still reach the model.
- `algorithm='csv'`: KMeans, proportional sampling, UniVote/SimVote and pooled
  unresolved regions from CSV Algorithms 1–3; no independent acceptance check.
  This comparison may miss rare positives and is not admitted by the product host.
- `sem_topk`: `heap` remains the reference default; `strategy='quick'` compares
  every active partition, performs quickselect and orders the selected rows.
  Neither a vector shortlist nor an unstable LLM comparator proves global Top-K.
- `sem_join`: explicit pairs remain the reference; `indexed_pairs` and the host's
  `blocking_field` use a disk inverted index. Measure blocking recall separately.
- `sem_map/sem_extract`: local Schema references are relocated under the payload
  definition. Valid identical inputs reuse their exact outputs and original
  request receipts, keyed by observation and Schema; no similarity-based copying.
- `sem_agg`: parent prompts contain child summaries and IDs, with lineage outside
  the prompt. Final source citations still use O(N) space. Targeted source reads
  remain explicit host actions; there is no automatic missing-fact read planner.
- `sem_search`: keyword work does not wait for rewritten embeddings. The Python
  API adds a numeric Rocchio lane from strong feedback and scans JSONL features
  in blocks. The product host's feedback expansion remains a reference path.

Run computation comparisons from the repository root:

```sh
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_filter.py
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_filter.py --size 4096 --seeds 0 --cases separable
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_secondary.py
```

Reports include actual strong batches/IDs, uncalled proxy IDs, per-phase requests,
quality/subgroups, fits, calibration, first/total time and metering. The scripted
oracle supplies no real token receipts: these remain unknown. Calls, tokens,
QPM, TPM and elapsed time are observations, never task quotas. Synthetic results
are not evidence of production semantic quality; memory probes cover only the
disk adapter's Python heap, not end-to-end million-row capacity.

Algorithm correspondence, fixed upstream versions and limitations are in the
[operator design](../../docs/design/OPERATORS.md).
