/** Shared file-port contracts; emitted with the package as well as used by the source CLI. */
export interface WikiEntry {
  schemaVersion: 2; id: string; revision: number; domain: string; title: string;
  kind: 'retrieval-prior' | 'retrieval-observation'; status: 'active';
  authority: 'reviewed-business-prior' | 'evidence-reviewed-observation'; isTicketEvidence: false;
  scope: string; keywords: string[]; bodyMarkdown: string; evidenceChecklist: string[]; limitations: string[]; supersedes: string[];
}
export interface PublishedWikiEntry extends WikiEntry { readonly reference: string; readonly releaseId: string }
export interface WikiLineage { id: string; revision: number; supersedes: string[] }
export interface PublishedWiki {
  readonly releaseId: string | null;
  readonly warning?: string;
  catalog(): { id: string; title: string; knowledgeRefs: string[] }[];
  /** Published identity history for validation; inactive bodies are never routed to models. */
  lineage(): WikiLineage[];
  revocations(): { id: string; revision: number }[];
  read(id: string): PublishedWikiEntry;
  search(query: string, options: { phase: 'first-pass' | 'post-fast-query'; domainIds?: string[]; limit?: number }): { id: string }[];
}
export interface WikiDelta {
  schemaVersion: 1; baseRelease: string | null;
  changes: { operation: 'add' | 'update' | 'deactivate'; id: string; entry?: WikiEntry }[];
  domains?: { id: string; title: string }[];
}
export interface PublicationResult { releaseId: string; duplicate: boolean; changedIds: string[] }
export interface PublicationOptions {
  /** Trusted host metadata only. Never sent to Wiki readers. */
  audit?: unknown;
  /** Runs after staging and validation, immediately before the atomic pointer replacement. */
  beforeCommit?: (result: PublicationResult, commit: () => Promise<void>) => Promise<void>;
  signal?: AbortSignal;
  requireBaseRelease?: boolean;
}
