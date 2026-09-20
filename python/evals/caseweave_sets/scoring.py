"""Set-retrieval scoring only. No retrieval, student model, or teacher oracle lives here."""
from collections import Counter, defaultdict
from typing import Iterable


def score_collection(universe: Iterable[str], labels: list[dict], selected: Iterable[str]) -> dict:
    universe, raw = set(universe), list(selected)
    selected = set(raw)
    outside = selected - universe
    by_id = {}
    for row in labels:
        key = row['ticket_id']
        if key not in universe:
            raise ValueError(f'Label outside declared corpus: {key}')
        if key in by_id:
            raise ValueError(f'Duplicate label; merge annotation passes explicitly: {key}')
        if row['label'] not in {'relevant', 'irrelevant', 'insufficient'}:
            raise ValueError(f'Unknown label: {row["label"]}')
        by_id[key] = row
    positive = {k for k, v in by_id.items() if v['label'] == 'relevant'}
    negative = {k for k, v in by_id.items() if v['label'] == 'irrelevant'}
    insufficient = set(by_id) - positive - negative
    unjudged = universe - by_id.keys()
    tp, fp, fn = len(selected & positive), len(selected & negative), len(positive - selected)
    complete = not unjudged and not insufficient and not outside
    unresolved_reference = insufficient | unjudged
    unknown_in = len(selected & unresolved_reference)
    unknown_out = len(unresolved_reference - selected)
    def ratio(a, b): return a / b if b else None
    bounds = None if outside else {
        'precision_lower': ratio(tp, len(selected)),
        'precision_upper': ratio(tp + unknown_in, len(selected)),
        'recall_lower': ratio(tp, len(positive) + unknown_out),
        'recall_upper': ratio(tp + unknown_in, len(positive) + unknown_in),
        'meaning': 'Worst-case bounds over unjudged/insufficient labels, not confidence intervals or estimates.'}
    definite = None
    if not unjudged and insufficient and not outside:
        selected_definite = selected & (positive | negative)
        definite = {'scope_size':len(positive | negative),
                    'precision':ratio(tp,len(selected_definite)), 'recall':ratio(tp,len(positive)),
                    'f1':ratio(2*tp,len(selected_definite)+len(positive)),
                    'meaning':'Fully annotated determinate subset only; not the entire corpus.'}
    # Sparse pooled labels are useful diagnostics, NOT global Precision/Recall.
    precision = (tp / len(selected) if selected else None) if complete else None
    recall = (tp / len(positive) if positive else None) if complete else None
    f1 = (2 * tp / (len(selected) + len(positive)) if selected or positive else 1.0) if complete else None
    groups = defaultdict(set)
    for key in positive:
        for group in by_id[key].get('subgroups', []):
            groups[group].add(key)
    subgroup_recall = {g: len(ids & selected) / len(ids) for g, ids in groups.items()} if complete else None
    return dict(corpus_size=len(universe), result_count=len(selected), duplicate_result_ids=len(raw)-len(selected),
        outside_corpus_ids=sorted(outside), labeled_count=len(by_id), unjudged_count=len(unjudged),
        insufficient_reference_count=len(insufficient), label_coverage=len(by_id)/len(universe) if universe else 1,
        global_bounds=bounds, definite_scope_metrics=definite,
        exact_scoring_available=complete, precision=precision, recall=recall, f1=f1,
        exact_match=(selected == positive) if complete else None,
        tp=tp if complete else None, fp=fp if complete else None, fn=fn if complete else None,
        fpr=(fp/len(negative) if negative else None) if complete else None,
        balanced_accuracy=(.5*(tp/len(positive)+1-fp/len(negative)) if positive and negative else None) if complete else None,
        known_positive_count=len(positive), known_positive_hits=tp,
        known_positive_coverage=tp/len(positive) if positive else None,
        known_negative_hits=fp, unjudged_selected_count=len(selected & unjudged),
        insufficient_selected_count=len(selected & insufficient),
        annotation_sources=dict(Counter(v.get('source', 'unspecified') for v in by_id.values())),
        subgroup_recall=subgroup_recall,
        subgroup_annotation_coverage=sum(bool(by_id[i].get('subgroups')) for i in positive)/len(positive) if positive else None,
        note='Sparse-source diagnostics are not unbiased estimates. Model-reference labels are not human Gold.')


def evaluate_task(task: dict, observed: dict, labels: list[dict], universe: Iterable[str]) -> dict:
    expected_rounds = 1 + len(task.get('followups', []))
    rounds = []
    for index, result in enumerate(observed.get('turns', [])):
        relevant = [r for r in labels if r['task_id'] == task['task_id'] and r.get('round', 0) == index]
        quality = score_collection(universe, relevant, result.get('ids', []))
        report = result.get('report')
        reported = report.get('confirmedCount') if isinstance(report, dict) else None
        count_correct = (reported == quality['result_count'] and quality['duplicate_result_ids'] == 0) if reported is not None else None
        rounds.append(dict(round=index, outcome=result.get('outcome'), metrics=quality,
            report_count_correct=count_correct, report_fact_review=result.get('report_fact_review'),
            result_revision=(result.get('result') or {}).get('resultRevision')))
    completed = not observed.get('error') and len(rounds) == expected_rounds and all(r['outcome'] == 'completed' for r in rounds)
    # Do not treat a missing report review or missing Gold as "passed".
    return dict(task_id=task['task_id'], product_task_id=observed.get('task_id'), expected_rounds=expected_rounds, observed_rounds=len(rounds),
        execution_completed=completed, rounds=rounds,
        all_rounds_exact_scoring_available=len(rounds)==expected_rounds and all(r['metrics']['exact_scoring_available'] for r in rounds),
        wall_seconds=observed.get('wall_seconds'), product_usage=observed.get('product_usage'),
        learning=observed.get('learning'), error=observed.get('error'),
        latency=observed.get('latency'), read_retries=observed.get('read_retries', []),
        failures=[{'outcome':t.get('outcome'),'failure':t.get('failure'),
            'stopping_reason':(t.get('result') or {}).get('stoppingReason'),
            'explanation':(t.get('result') or {}).get('explanation')} for t in observed.get('turns',[]) if t.get('outcome')!='completed'],
        business_pass=None,
        business_pass_note='No invented acceptance threshold; inspect set quality, report review, completion and configured quality targets separately.')


def quality_curve(steps: list[dict], universe: Iterable[str], labels: list[dict],
                  checkpoints: tuple[float, ...] = (.95, .99)) -> dict:
    """Post-hoc eval only. Production must never see these labels or stop on them."""
    selected, judged = set(), set()
    curve = []
    for step in steps:
        selected.difference_update(step.get('accept_remove', []))
        selected.update(step.get('accept_add', []))
        judged.update(step.get('strong_judged_ids', []))
        q = score_collection(universe, labels, selected)
        curve.append(dict(step=step['step'], elapsed_seconds=step.get('elapsed_seconds'),
            strong_unique_rows=len(judged), precision=q['precision'], recall=q['recall'], f1=q['f1']))
    return {'curve':curve,'first_observed_recall_checkpoints':{
        str(r):next((s for s in curve if s['recall'] is not None and s['recall'] >= r),None)
        for r in checkpoints},'note':'A checkpoint is not a stopping signal or a maintained quality guarantee; precision is reported alongside recall.'}


def summarize(results: list[dict]) -> dict:
    rounds=[r for x in results for r in x['rounds']]
    full=[r for r in rounds if r['metrics']['exact_scoring_available']]
    completed_full=[r for x in results if x['execution_completed'] for r in x['rounds'] if r['metrics']['exact_scoring_available'] and r['outcome']=='completed']
    def average(key, rows):
        values=[r['metrics'][key] for r in rows if r['metrics'][key] is not None]
        return sum(values)/len(values) if values else None
    return dict(task_count=len(results), completed_tasks=sum(x['execution_completed'] for x in results),
        returned_rounds=len(rounds), exact_scored_rounds=len(full), completed_exact_scored_rounds=len(completed_full),
        macro_precision_completed=average('precision',completed_full),
        macro_recall_completed=average('recall',completed_full), macro_f1_completed=average('f1',completed_full),
        incomplete_or_missing_gold_tasks=[x['task_id'] for x in results if not x['all_rounds_exact_scoring_available']],
        failed_or_incomplete_tasks=[x['task_id'] for x in results if not x['execution_completed']],
        report_count_mismatches=sum(r['report_count_correct'] is False for r in rounds),
        note='Quality denominator is shown explicitly. Failed tasks are not discarded from the task outcome table; incomplete annotation is never filled with negative labels.')


def learning_metrics(universe, labels, selected, trace):
    """Consumes normalized REAL Host observations, not configuration or guessed counts."""
    if trace is None:
        return None
    universe=set(universe);judged=set(trace['strong_judged_ids']);scored=set(trace['student_scored_ids'])
    selected=set(selected);proxy_accept=(selected & scored)-judged
    known={r['ticket_id']:r['label'] for r in labels}
    labeled_proxy={i for i in proxy_accept if known.get(i) in {'relevant','irrelevant'}}
    return {'strong_unique_rows':len(judged),'student_scored_unique_rows':len(scored),
        'uncovered_by_either_rows':len(universe-(judged|scored)),
        'actual_fit_or_update_events':len(trace['fit_events']),
        'proxy_accepted_without_any_per_row_strong_judgment':len(proxy_accept),
        'proxy_accept_reference_coverage':len(labeled_proxy)/len(proxy_accept) if proxy_accept else None,
        'proxy_precision_on_labeled_only':sum(known[i]=='relevant' for i in labeled_proxy)/len(labeled_proxy) if labeled_proxy else None,
        'note':'Labeled-only proxy precision is not an unbiased estimate when labels are incomplete; no global LLM-saving ratio is inferred.'}
