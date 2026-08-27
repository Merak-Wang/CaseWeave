import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  makeRetrievalEvent,
  type RetrievalDomainEvent,
  type RetrievalEventDataMap,
  type RetrievalEventType,
  type RetrievalId,
} from '@retrieval-agent/contracts'
import type { RetrievalEventJournal } from '@retrieval-agent/domain'
import {
  appendRetrievalSessionEvent,
  readRetrievalSessionEvents,
} from '@retrieval-agent/dsh-compat'

export interface SessionJournalOptions {
  readonly now?: () => Date
  readonly eventId?: () => string
}

/** Journal that writes the complete domain envelope into the owning DSH Session. */
export class SessionRetrievalEventJournal implements RetrievalEventJournal {
  readonly #session: Session
  readonly #events = new Map<RetrievalId, RetrievalDomainEvent[]>()
  readonly #now: () => Date
  readonly #eventId: () => string

  constructor(session: Session, options: SessionJournalOptions = {}) {
    this.#session = session
    this.#now = options.now ?? (() => new Date())
    this.#eventId = options.eventId ?? (() => randomUUID())
    for (const event of readRetrievalSessionEvents(session)) {
      const events = this.#events.get(event.retrievalId) ?? []
      events.push(event)
      this.#events.set(event.retrievalId, events)
    }
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
    appendRetrievalSessionEvent(this.#session, event)
    events.push(event)
    this.#events.set(retrievalId, events)
    return event
  }

  read(retrievalId: RetrievalId): readonly RetrievalDomainEvent[] {
    return [...this.#events.get(retrievalId) ?? []]
  }

  all(): readonly RetrievalDomainEvent[] {
    return [...this.#events.values()].flat()
  }
}
