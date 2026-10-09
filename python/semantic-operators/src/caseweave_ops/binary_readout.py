"""AnyJev二元轮换、无标签先验修正；宿主HTTP读取，Runtime统一预算。"""
import asyncio
import numpy as np
from .types import Decision, verify_citations

READOUT_SCHEMA = {'type': 'object', 'additionalProperties': False,
    'required': ['available', 'p_first', 'unavailable_reason'], 'properties': {
    'available': {'type': 'boolean'}, 'p_first': {'type': ['number', 'null'], 'minimum': 0, 'maximum': 1},
    'unavailable_reason': {'type': 'string'}}}


async def judge_readout(runtime, records, instruction, key, compact_fallback, use_cache, sampling):
    if not hasattr(runtime, 'judge_metrics'):
        runtime.judge_metrics = {'requested_mode': 'anyjev_l0', 'l0_records': 0,
            'rotation_only_records': 0, 'compact_fallback_records': 0}
    if getattr(runtime, 'label_logprobs_unavailable', False):
        outcomes = await compact_fallback(records)
        runtime.judge_metrics['compact_fallback_records'] += len(records)
        runtime.store.observe(runtime.scope.task_id, 'binary_readout', runtime.judge_metrics)
        return outcomes
    prior_method = getattr(runtime, 'judge_prior', 'none')
    content_free_prior = getattr(runtime, 'content_free_prior', None)
    async def calibrate_once():
        async def calibration(probe, rotation):
            reply = await runtime.call('sem_filter', instruction, {
                'decision_format': 'next_token_binary', 'rotation': rotation,
                'calibration_state': probe, 'records': []}, READOUT_SCHEMA, sampling=sampling)
            if not reply.payload['available']:
                runtime.label_logprobs_unavailable = True
            return rotation, reply.payload['p_first'] if reply.payload['available'] else None
        calibration_scores = await asyncio.gather(*(calibration(p, k)
            for p in ('N/A', '', '[MASK]') for k in range(2)))
        if all(score is not None for _, score in calibration_scores):
            content_free_prior = np.asarray([[np.mean([s for k, s in calibration_scores if k == j]),
                1-np.mean([s for k, s in calibration_scores if k == j])] for j in range(2)])
            return content_free_prior
        return None
    if prior_method == 'content_free' and content_free_prior is None:
        # 首批并发共享同一校准任务，六次探针只计一次。
        if not hasattr(runtime, 'content_free_calibration'):
            runtime.content_free_calibration = asyncio.create_task(calibrate_once())
        content_free_prior = await runtime.content_free_calibration
        runtime.content_free_prior = content_free_prior
        if getattr(runtime, 'label_logprobs_unavailable', False):
            return await judge_readout(runtime, records, instruction, key, compact_fallback, use_cache, sampling)
    async def read(record, rotation):
        reply = await runtime.call('sem_filter', instruction, {
            'decision_format': 'next_token_binary', 'rotation': rotation,
            'records': [record.model_payload()]}, READOUT_SCHEMA, use_cache=use_cache, sampling=sampling)
        return record.ref, rotation, reply
    readings = await asyncio.gather(*(read(r, k) for r in records for k in range(2)))
    by_ref = {r.ref: {} for r in records}
    for ref, rotation, reply in readings:
        by_ref[ref][rotation] = reply
    valid, failed = [], []
    for r in records:
        pair = by_ref[r.ref]
        if all(pair[k].payload['available'] and pair[k].payload['p_first'] is not None for k in range(2)):
            valid.append(r)
        else:
            failed.append(r)
    outcomes = {}
    if failed:
        runtime.label_logprobs_unavailable = True
        # 能力缺失另占一次短JSON请求；实际降级写入计量与结果说明。
        for d in await compact_fallback(failed):
            outcomes[d.ref] = d
    metrics = getattr(runtime, 'judge_metrics', {'requested_mode': 'anyjev_l0',
        'l0_records': 0, 'rotation_only_records': 0, 'compact_fallback_records': 0})
    metrics['compact_fallback_records'] += len(failed)
    if valid:
        scores = np.asarray([[[by_ref[r.ref][k].payload['p_first'],
            1-by_ref[r.ref][k].payload['p_first']] for k in range(2)] for r in valid])
        prior_used = prior_method == 'batch' and len(valid) >= 8 or prior_method == 'content_free' and content_free_prior is not None
        if prior_used:
            prior = np.clip(content_free_prior if prior_method == 'content_free' else scores.mean(axis=0), 1e-8, None)
            prior /= prior.sum(axis=-1, keepdims=True)
            scores = np.clip(scores / prior**(1 if prior_method == 'content_free' else .75), 1e-8, None)
            scores /= scores.sum(axis=-1, keepdims=True)
        aligned = np.stack([scores[:, 0], scores[:, 1, ::-1]], axis=1)
        logits = np.log(np.clip(aligned, 1e-12, None)).mean(axis=1)
        distribution = np.exp(logits-logits.max(axis=1, keepdims=True))
        distribution /= distribution.sum(axis=1, keepdims=True)
        mode = 'anyjev_l0' if prior_used else 'rotation_only'
        metrics['l0_records' if prior_used else 'rotation_only_records'] += len(valid)
        for r, probabilities in zip(valid, distribution):
            runtime.store.observe(runtime.scope.task_id, 'binary_readout_pair', {
                'ref': r.ref, 'rotation_manifests': [by_ref[r.ref][k].manifest_id for k in range(2)],
                'requested_prior': prior_method, 'prior_applied': bool(prior_used),
                'p_yes': float(probabilities[0])})
            citations = verify_citations([{'ref': r.ref, 'passage_id': p.id, 'quote': p.text}
                for p in r.passages if p.text and p.field != 'displayId'], [r])
            outcomes[r.ref] = Decision(r.ref, r.identity, key,
                'accept' if probabilities[0] >= probabilities[1] else 'exclude', citations,
                reason=f'{mode}：两轮标签分布判断；分数未校准。',
                manifest_id=by_ref[r.ref][1].manifest_id, confidence=float(probabilities.max()))
    runtime.judge_metrics = metrics
    metrics['requested_prior'] = prior_method
    runtime.store.observe(runtime.scope.task_id, 'binary_readout', metrics)
    return [outcomes[r.ref] for r in records]
