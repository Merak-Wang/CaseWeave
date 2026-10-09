import numpy as np
import pytest
from retrieval_agent_evals.anyjev_http import l0_probabilities, decide_batch
from retrieval_agent_evals.teacher_transport import TeacherConfig, TransportResult


def test_two_rotations_cancel_additive_position_bias_without_labels():
    # 真实语义优势为2，位置Y偏好为3；两轮还原后抵消位置偏好。
    sigmoid = lambda z: 1/(1+np.exp(-z))
    first, second = sigmoid(5), sigmoid(1)
    p, used = l0_probabilities([[[first, 1-first], [second, 1-second]]])
    assert not used and p[0, 0] == pytest.approx(sigmoid(2))


def test_batch_prior_and_logmean_are_order_independent():
    p = np.asarray([[[.95,.05],[.7,.3]],[[.2,.8],[.9,.1]]]*4)
    forward, used = l0_probabilities(p)
    reversed_rows, _ = l0_probabilities(p[::-1])
    assert used and np.allclose(forward, reversed_rows[::-1])
    assert np.allclose(forward.sum(axis=1), 1)


def test_http_missing_logprobs_requires_explicit_fallback_not_fabricated_confidence():
    def request(*args, **kwargs):
        return TransportResult(payload={'model':'synthetic','choices':[{'message':{'content':'Y'}}]},
            value=None, error_code=None, elapsed_ms=1, attempts=[])
    config = TeacherConfig('https://synthetic.invalid', 'synthetic', 'fixture')
    out = decide_batch(config, ['invented ticket'], 'invented query', requester=request)
    assert out[0]['fallback_required'] and out[0]['p_yes'] is None and out[0]['level']=='unavailable'
