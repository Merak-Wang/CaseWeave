import { rankSourceHits } from '@retrieval-agent/model-service-client/ranking'
import type { MilvusHit } from './milvus.js'
export interface RewriteHit { readonly hit:MilvusHit; readonly source:string }
/** Best cosine across unique expressions; provenance is kept, repeated results have no weight. */
export function rankRewriteHits(input:Iterable<RewriteHit>): Array<{hit:MilvusHit;rank:number;sources:string[]}> {
 const best=new Map<string,MilvusHit>(), sources=new Map<string,Set<string>>()
 for(const {hit,source} of input) {
  if(!Number.isFinite(hit.distance)) continue
  const previous=best.get(hit.ticket_id)
  if(!previous || hit.distance>previous.distance || hit.distance===previous.distance && hit.id<previous.id) best.set(hit.ticket_id,hit)
  const origins=sources.get(hit.ticket_id)??new Set<string>(); origins.add(source); sources.set(hit.ticket_id,origins)
 }
 return rankSourceHits([...best].map(([documentId,hit])=>({documentId,score:hit.distance}))).map(row=>({hit:best.get(row.documentId)!,rank:row.rank,sources:[...sources.get(row.documentId)!].sort()}))
}
