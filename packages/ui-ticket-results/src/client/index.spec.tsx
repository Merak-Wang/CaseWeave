/// <reference path="../css-modules.d.ts" />

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./CandidatePanel.js', () => ({ CandidatePanel: () => null }))
vi.mock('./HeaderExport.js', () => ({ ProductHeaderExport: () => null }))
vi.mock('./definition.js', () => ({ ticketCandidateDefinition: { kind: 'ticket-candidates' } }))

import { apply } from './index.js'

describe('ticket-results client registration', () => {
  it('shadows generic assistant prose while retaining the deterministic candidate renderer', () => {
    const registered: Array<{ readonly name: string; readonly key?: string; readonly priority?: number }> = []
    const ctx = {
      uiConversation: { events: { register: vi.fn() } },
      slots: {
        inject: (_name: string, install: () => unknown) => install(),
        register: (options: { readonly name: string; readonly key?: string; readonly priority?: number }) => {
          registered.push(options)
          return () => undefined
        },
      },
    } as unknown as ClientContext

    apply(ctx)

    expect(registered).toContainEqual(expect.objectContaining({ name: 'conversation.session.header.utilities' }))

    expect(registered).toContainEqual({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: -100,
    })
    expect(registered).toContainEqual({
      name: 'conversation.chat.node',
      key: 'ticket-candidates',
    })
  })
})
