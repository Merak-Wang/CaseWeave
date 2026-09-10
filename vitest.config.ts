import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.spec.{ts,tsx}', 'tests/**/*.spec.{ts,tsx}'],
    // DSH preset loading imports whole plugin graphs. Match CI's worker budget
    // so concurrent cold imports do not exhaust the per-test time allowance.
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['packages/*/src/**/*.d.ts'],
    },
  },
})
