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

Aligned IDs carry float32/optional CSR blocks and optional snapshot-bound canonical title/summary texts. Index preparation normalizes document vectors once. Rank the complete keyword-OR and cosine>=0.75 recall union by original-query n-gram coverage and cosine, then label exactly the first128 tickets (or the entire union if smaller). Do not replace them with random exploration, extend the sample or request a second positive review.

S2 always submits batches of eight with only ref, yes/no and self-reported confidence. No token logprobs, label rotations, priors or confidence calibration run. The valid teacher pseudo-label is y; document embeddings and canonical texts are X. Ranking similarity is neither the label nor a classification feature. Fit eleven vector candidates plus text LR and text LinearSVC on the same labels with balanced training weights. Text candidates use character 2–4gram TF-IDF with sublinear TF and at most 20000 features; each fold learns vocabulary and IDF only from its training texts. Missing optional texts disable text candidates for default callers; explicitly requested text candidates require that view.

Choose finite OOF thresholds by Balanced Accuracy, breaking ties by precision then recall. Rank models by Balanced Accuracy, precision, F1, coverage and fit time. A fusion of up to three binary voters must improve OOF Balanced Accuracy without reducing the current selection's precision. Refit selected models on all valid128 labels; even vote ties use the best OOF member. Precision/recall targets report feasibility only. Report confusion counts and specificity; Balanced Accuracy is null for a single teacher class. No fixed final-reference or precision gate blocks publication. One-class samples use a real-label constant fallback, without fabricating another class.

With learning disabled, the chosen no-feedback operator directly classifies the full recall union without training labels. Teacher yes labels and final model yes labels form the ordinary result/XLSX collection, without human confirmation. Preserve teacher/model origin; do not fabricate a per-row teacher receipt. Confidence and empirical OOF metrics are not calibrated business accuracy.

Transport, parsing and feature failures are execution errors, never no labels or a third semantic class. Resumes reuse completed fixed-sample labels; all physical requests and retries count toward usage, QPM, TPM and time. Technical retries do not expand the128-ticket sample.

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
uv run --frozen --inexact --project python/semantic-operators python python/semantic-operators/examples/benchmark_learning.py --size 100000
```

The benchmark exercises the actual default numerical route using memmap and an
explicit scripted teacher. It does not measure actual LLM quality, Chinese business labels, MySQL I/O or 40M capacity.
Unknown measurements remain null. Full learning runs through the existing Host's
numerical Provider.

The Host runs `python -m caseweave_ops.server --stdio --state <path>` as its persistent
NDJSON worker. There is no standalone WebSocket operators service.
See the [operator design](../../docs/design/OPERATORS.md)
for wiring, assumptions and remaining production validation boundaries.
