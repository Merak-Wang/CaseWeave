import type { RankingHit } from './types.js'
export interface RrfOptions { readonly rankConstant?: number; readonly keywordWeight?: number; readonly vectorWeight?: number }
type RawHit = Pick<RankingHit, 'documentId' | 'score'>
/** Global source dedup by best raw score; equal scores share competition rank. */
export function rankSourceHits(input: Iterable<RawHit>): Array<RawHit & {rank:number}> {
  const best = new Map<string,number>()
  for (const hit of input) if (Number.isFinite(hit.score) && (best.get(hit.documentId) === undefined || hit.score > best.get(hit.documentId)!)) best.set(hit.documentId,hit.score)
  const hits = [...best].map(([documentId,score])=>({documentId,score,rank:0})).sort((a,b)=>b.score-a.score || (a.documentId<b.documentId?-1:a.documentId>b.documentId?1:0))
  let previous:number|undefined, rank=0
  hits.forEach((hit,i)=>{if(previous===undefined || hit.score!==previous) rank=i+1; hit.rank=rank; previous=hit.score})
  return hits
}
/** Each document contributes once per source; lexical and cosine units never mix. */
export function fuseRankingHits(keyword: Iterable<RawHit>, dense: Iterable<RawHit>, options:RrfOptions = {}): RankingHit[] {
  const constant=options.rankConstant??60, weights={keyword:options.keywordWeight??.55,vector:options.vectorWeight??.45}
  if(!Number.isFinite(constant)||constant<=0||Object.values(weights).some(w=>!Number.isFinite(w)||w<0)||weights.keyword+weights.vector<=0) throw new TypeError('Invalid RRF options')
  const rows=new Map<string,RankingHit>()
  for(const [channel,input] of [['keyword',keyword],['vector',dense]] as const) {
    if(weights[channel]===0) continue
    for(const hit of rankSourceHits(input)) {
      const old=rows.get(hit.documentId)
      const score=(old?.score??0)+weights[channel]/(constant+hit.rank)
      rows.set(hit.documentId,{...old,documentId:hit.documentId,rank:0,score,fused:score,
        ...(channel==='keyword'?{lexical_raw:hit.score}:{dense_raw:hit.score}),
        channels:[...old?.channels??[],{channel,rank:hit.rank,score:hit.score}]})
    }
  }
  return [...rows.values()].sort((a,b)=>b.score-a.score || (a.documentId<b.documentId?-1:a.documentId>b.documentId?1:0)).map((hit,i)=>({...hit,rank:i+1}))
}
