import asyncio
import pytest
from caseweave_ops.model import Runtime, ModelReply
from caseweave_ops.planner import plan_query
from caseweave_ops.store import ArtifactStore
from caseweave_ops.types import Scope, Knowledge, ProtocolError


def test_invalid_plan_is_not_reused_after_operator_validation_failed():
    class Model:
        identity = 'review-fixture'
        calls = 0

        async def generate(self, request):
            self.calls += 1
            return ModelReply({
                'keywords': ['宽带'], 'instruction': '只找宽带案例', 'retrieval_expressions': [],
                'goal': {'mode': 'adaptive', 'count': 3 if self.calls == 1 else None},
                'steps': [{'id': 'filter', 'op': 'sem_filter', 'inputs': ['$source'],
                           'instruction': '依据证据判断', 'params': {}}],
            })

    async def run():
        model, store = Model(), ArtifactStore()
        try:
            runtime = Runtime(Scope('review-task', 0, 'snapshot', 'authorization'), model, store, Knowledge('none'))
            with pytest.raises(ProtocolError):
                await plan_query(runtime, '查找宽带案例')
            try:
                await plan_query(runtime, '查找宽带案例')
            except ProtocolError:
                pass
            print({'model_calls_after_two_plan_attempts': model.calls})
            assert model.calls == 2, 'A rejected plan is served from cache forever; the model cannot repair it'
        finally:
            store.close()

    asyncio.run(run())
