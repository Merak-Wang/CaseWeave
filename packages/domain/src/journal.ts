import { randomUUID } from 'node:crypto'
import {
  makeRetrievalEvent,
  type RetrievalDomainEvent,
  type RetrievalEventDataMap,
  type RetrievalEventType,
  type RetrievalId,
} from '@retrieval-agent/contracts'

export interface RetrievalEventJournal {
  append<T extends RetrievalEventType>(retrievalId: RetrievalId, type: T, data: RetrievalEventDataMap[T]): RetrievalDomainEvent<T>
  read(retrievalId: RetrievalId): readonly RetrievalDomainEvent[]
}
export interface JournalOptions {
  readonly now?: () => Date
  readonly eventId?: () => string
}

export class InMemoryRetrievalEventJournal implements RetrievalEventJournal {
  readonly #events = new Map<RetrievalId, RetrievalDomainEvent[]>()
  readonly #now: () => Date
  readonly #eventId: () => string

  constructor(options: JournalOptions = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#eventId = options.eventId ?? (() => randomUUID())
  }

  append<T extends RetrievalEventType>(retrievalId: RetrievalId, type: T, data: RetrievalEventDataMap[T]): RetrievalDomainEvent<T> {
    const events = this.#events.get(retrievalId) ?? []
    const event = makeRetrievalEvent({
      eventId: this.#eventId(),
      retrievalId,
      sequence: events.length,
      occurredAt: this.#now().toISOString(),
      type,
      data,
    })
    events.push(event)
    this.#events.set(retrievalId, events)
    return event
  }

  read(retrievalId: RetrievalId): readonly RetrievalDomainEvent[] {
    return [...this.#events.get(retrievalId) ?? []]
  }
}
