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

Aligned IDs carry numerical blocks and optional snapshot-bound canonical title/summary texts. The recall union contains every keyword-OR hit and cosine>=0.65 semantic hit. Default `ranked_top128` selects the first 128 tickets by the actual combined n-gram and cosine ranking, or all tickets when the union is smaller. Optional `stratified_diverse` samples up to 128 tickets across eight rank strata, choosing vector-diverse records within each stratum with a fixed seed and stable ID ties. The diverse sampler currently collects union vectors in memory; capacity beyond tested datasets remains unverified.

S2 uses compact batches of up to eight binary decisions with self-reported confidence. The default bank contains the original 13 models plus `joint_lr` (14 candidates), with `fusion=selective`: it chooses between the best single model and a selected ensemble of at most three models, rather than voting across all 14. All candidates reuse the same at most 128 teacher labels. Explicit options retain `fusion=single`, the `dense_lr`/`text_svm`/`joint_lr` subset, and stratified sampling. Character TF-IDF (2–4 grams, max 20000 features) and joint-vector scaling are fitted only within each training fold. Ranking similarity is neither the label nor a classification feature.

Select OOF thresholds and models by the original precision/recall targets first. If infeasible, maximize recall among candidates with precision >=0.60, then break ties using Balanced Accuracy and the recorded secondary metrics. Refit selected models on valid training labels. Below the precision floor, with one teacher class, or with insufficient cross-fit evidence, publish no learned full-union prediction: return unknown/incomplete and retain confirmed teacher results. OOF metrics are teacher agreement, not independent business accuracy.

With learning disabled, the chosen no-feedback operator directly classifies the full recall union without training labels. Teacher yes labels and final model yes labels form the ordinary result/XLSX collection, without human confirmation. Preserve teacher/model origin; do not fabricate a per-row teacher receipt. Confidence and empirical OOF metrics are not calibrated business accuracy.

Transport, parsing and feature failures remain execution errors, never negative labels. Initial and review decisions share at most 128 independent judgments per query generation; the current implementation uses one sample round and no additional audit. Resume reuses completed judgments. Actual requests and retries are metered separately; retries do not consume another independent judgment.

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
| `server.py`, `__init__.py` | Persistent stdio worker, and public operator dispatch |

Standalone JSONL/embedding/model adapters and the separate live CLI are removed.
Data, embeddings and models enter through the existing Host. Synthetic experiments do not measure business accuracy.

## Run and verify

From the repository root:

```sh
pnpm operators:test
pnpm operators:serve --stdio
```

Full learning runs through the existing Host's numerical Provider.

The Host runs `python -m caseweave_ops.server --stdio --state <path>` as its persistent
NDJSON worker. There is no standalone WebSocket operators service.
See the [operator design](../../docs/design/OPERATORS.md)
for wiring, assumptions and remaining production validation boundaries.
