import type { QueryAnalysisResponse, TicketQueryAnalyzer } from '@retrieval-agent/query-understanding'

export function fixtureQueryAnalyzer(
  keywords: readonly string[],
  operator?: 'and' | 'or',
): TicketQueryAnalyzer {
  return {
    async analyze(query: string): Promise<QueryAnalysisResponse> {
      const tokens = keywords.map((text, index) => ({
        text, start: query.indexOf(text), end: query.indexOf(text) + text.length,
        lemma: text, pos: 'NOUN', tag: 'NN', dep: index === 0 ? 'ROOT' : 'conj',
        head: index === 0 ? 0 : index - 1, isStop: false, entityType: '',
      }))
      return {
        protocolVersion: 'retrieval-agent.models.v1', requestId: 'fixture',
        analyzer: {
          engine: 'spacy', engineVersion: '3.8.7', pipeline: 'zh_core_web_sm-3.8.0',
          pipelineVersion: '3.8.0', lexiconVersion: 'telecom-query-phrases-v1', loaded: true,
          components: ['tagger', 'parser'],
        },
        language: 'zh', keywords,
        candidates: keywords.map(text => ({
          text, start: query.indexOf(text), end: query.indexOf(text) + text.length,
          source: 'pos' as const, pos: ['NOUN'],
        })),
        tokens, entities: [],
        triples: operator === undefined ? [] : [{
          subject: keywords[0]!, predicate: operator, object: keywords[1]!, source: 'coordination',
        }],
        ...(operator === undefined ? {} : { boolean: { operator, terms: keywords, grouping: 'single_set' as const } }),
        elapsedMs: 1,
      }
    },
  }
}
