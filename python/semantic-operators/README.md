# CaseWeave semantic operators

The production semantic surface is **sem_filter, sem_extract, sem_agg**. Search/read
remain base capabilities. The existing TypeScript/DSH Host owns models, authorization,
tasks, source reads and publication. Python supplies algorithms, not another Agent.

## Default recall-union filter

`invoke_rows("sem_filter", ...)` defaults to `algorithm="auto"` and
`scope_mode="full"`; “full” means the deduplicated union of all keyword-OR hits and
the configured semantic-recall results, not every ticket in the authorized corpus.
The keyword branch enumerates all literal hits. `learned` is the same implementation;
`active` is a thin configuration alias for existing callers. Missing numerical resources
fail explicitly. They never select all-row LLM fallback.
`direct` with full scope enumerates every authorized recall-union ID and reads actual
source rows for frozen teacher judgments, without fitting or feedback training. Missing
vectors do not drop tickets. Candidate/example scopes remain small references;
`baseline/cluster` retain the old filter for matched migration comparisons only.

Aligned IDs and float32/optional CSR blocks are separate from text. Index preparation normalizes document vectors once. Rank the complete keyword-OR and cosine>=0.75 recall union by original-query n-gram coverage and cosine, then label exactly the first128 tickets (or the entire union if smaller). Do not replace them with random exploration, extend the sample or request a second positive review.

S2 emits only yes/no and confidence. The valid teacher pseudo-label is y; embeddings are X, and ranking similarity is never the label. Fit LR, LinearSVC, shallow MLP, HGB, feedback prototypes and relation logistic on the shared labels. Training OOF selects models and thresholds; refit selected models on all valid128 labels and use at most three binary voters for remaining union members. Even ties use the best OOF member. No fixed final-reference or precision gate blocks publication. One-class samples use a real-label constant fallback, without fabricating another class.

With learning disabled, the chosen no-feedback operator directly classifies the full recall union without training labels. Teacher yes labels and final model yes labels form the ordinary result/XLSX collection, without human confirmation. Preserve teacher/model origin; do not fabricate a per-row teacher receipt. Confidence and empirical OOF metrics are not calibrated business accuracy.

Transport, parsing and feature failures are execution errors, never no labels or a third semantic class. Resumes reuse completed fixed-sample labels; all physical requests, AnyJev rotations and retries count toward usage, QPM, TPM and time. Technical retries do not expand the128-ticket sample. Legacy baseline routes remain explicit research comparisons only.

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
| `models.py`, `features.py` | Model fitting/selection, numeric blocks and ranked sampling |
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
This external transport remains an explicit integration option; normal app/compose startup uses the app's persistent stdio worker and does not create a separate operators container.
An optional `CASEWEAVE_OPERATORS_TOKEN` must match both endpoints. Without a service URL,
the Host runs `python -m caseweave_ops.server --stdio --state <path>` as its persistent
NDJSON worker. See the [operator design](../../docs/design/OPERATORS.md)
for wiring, assumptions and remaining production validation boundaries.
