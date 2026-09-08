import threading
import time
from concurrent.futures import ThreadPoolExecutor
import pytest
from retrieval_agent_model_service.backend import QwenModelBackend
from retrieval_agent_model_service.errors import ServiceError


def backend():
    value = object.__new__(QwenModelBackend)
    value._gate = threading.BoundedSemaphore(1)
    value._priority_lock = threading.Lock()
    value._interactive_waiters = 0
    return value


def test_interactive_embedding_precedes_queued_index_batch():
    value = backend()
    order = []
    value.embed = lambda texts, kind, instruction, dimensions, **kwargs: order.append(kind) or [[1.0]]
    value._gate.acquire()
    query_timing = {}
    with ThreadPoolExecutor(2) as workers:
        document = workers.submit(value.embed_measured, ['doc'], 'document', None, 1, {}, threading.Event(), True)
        query = workers.submit(value.embed_measured, ['query'], 'query', None, 1, query_timing, threading.Event(), True)
        deadline = time.monotonic() + 2
        while value._interactive_waiters == 0 and time.monotonic() < deadline:
            time.sleep(0.001)
        value._gate.release()
        query.result(timeout=2)
        document.result(timeout=2)
    assert order == ['query', 'document']
    assert query_timing['queueMs'] >= 0
    assert query_timing['computeMs'] >= 0


def test_cancelled_queued_embedding_never_computes_or_leaks_gate():
    value = backend()
    value.embed = lambda *args, **kwargs: pytest.fail('cancelled job must not compute')
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(ServiceError) as error:
        value.embed_measured(['x'], 'query', None, 1, {}, cancel, True)
    assert error.value.code == 'CANCELLED'
    assert value._interactive_waiters == 0
    assert value._gate.acquire(blocking=False)
