# CaseWeave semantic operators

The production semantic surface is **sem_filter, sem_extract, sem_agg**. Search/read
remain base capabilities. The existing TypeScript/DSH Host owns models, authorization,
tasks, source reads and publication. Python supplies algorithms, not another Agent.

## Default full-scope filter

`invoke_rows("sem_filter", ...)` defaults to `algorithm="auto"` and
`scope_mode="full"`, using the Host's authorized numeric resource port. `learned`
is the same implementation; `active` is a thin configuration alias for existing callers.
Missing numerical resources fail explicitly. They never select all-row LLM fallback.
Explicit `direct`/candidate scopes serve small references; `baseline/cluster` retain
the old filter for matched migration comparisons only.

Aligned IDs and float32/optional CSR blocks are separate from text. Index preparation
aggregates and normalizes document chunks once. A bounded pool mixes discovery and
exploration; only teacher samples read source text. Shared labels actually fit sklearn
LR, LinearSVC, shallow MLP and HGB. Separate selection labels choose the model and
threshold. After freezing, one full numerical scan writes block predictions and draws
an independent audit. Linear inference folds the fitted scaler without quantization.

Finite-population TP/FN intervals yield set Precision/Recall lower bounds. Missing
features and unknown observations remain in the missed-positive bound. Historical audit
labels used for training cannot enter a new independent audit. Repeated measurements
allocate delta. Bounds assume truthful reference labels and SRS; they do not establish
business truth or reproduce SUPG. Failure returns a concrete next action, never a hidden
full teacher loop. Calls/tokens/time are metered, not task completion budgets.

The production MySQL result store saves accepted IDs in batches; state carries one
model/quality descriptor. Paging, reports and downloads use that descriptor, not the
sample candidate array. Uncalled predictions have no fabricated teacher receipt.

## Facts and answers

`sem_extract(field_map=...)` reads/parses explicitly supplied source fields without
model calls; missing facts stay unknown. Open facts use the existing DSH reader with
field citations. `sem_agg(numeric_fields=...)` computes supplied-record statistics
before invoking the existing writer. Missing values invalidate exact totals/means.
`evidence_window` selects diverse confirmed examples with MMR; it never changes set
membership or claims complete statistical coverage. Summary nodes reference parents
and an independent leaf-evidence index instead of copying all leaf text at every level.

The map/topk/join implementations, dispatch branches and product tools have been
removed. Query understanding remains the existing Host's single DSH call;
Python does not start another Agent or independently connect to model/data services.

## Code layout

| Files | Responsibility |
| --- | --- |
| `filter.py`, `extract.py`, `aggregate.py` | The three operators; evidence-window selection belongs to aggregation |
| `models.py`, `quality.py`, `features.py` | Model fitting, independent quality intervals, numeric blocks and sampling |
| `search.py` | The existing one-call query plan and Host search callbacks |
| `runtime.py`, `types.py` | Host model calls, cache/metering, source records and results |
| `server.py`, `__init__.py` | One service for stdio/WebSocket, and public operator dispatch |
| `baseline.py` | Explicit old-filter migration comparison, loaded only when requested |

Standalone JSONL/embedding/model adapters and the separate live CLI are removed.
Data, embeddings and models enter through the existing Host. The two benchmark
scripts remain explicit synthetic experiments.

## Run and verify

From the repository root:

```sh
pnpm operators:test
pnpm operators:serve --port 8013
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_learning.py --size 100000
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_filter.py --size 256 --seeds 0 --cases separable --variants full,checked
```

The first benchmark exercises the actual default numerical route using memmap and an
explicit scripted teacher. The second is the explicit old baseline, not the default.
Neither measures actual LLM quality, Chinese business labels, MySQL I/O or 40M capacity.
Unknown measurements remain null. Full learning runs through the existing Host's
numerical Provider.

`CASEWEAVE_OPERATORS_URL=http://127.0.0.1:8013` selects the private FastAPI WebSocket.
An optional `CASEWEAVE_OPERATORS_TOKEN` must match both endpoints. Without a service URL,
the Host runs `python -m caseweave_ops.server --stdio --state <path>` as its persistent
NDJSON worker. See the [operator design](../../docs/design/OPERATORS.md)
for wiring, assumptions and remaining production validation boundaries.
