const unexpected = (): never => { throw new Error('This component fixture must not mutate an Agent inbox') }
/** These component tests exercise hooks only; inbox behavior is covered by the real DSH loop. */
export const unusedInbox = {
  nextTurn: [], nextStep: [], clear: unexpected, append: unexpected, prepend: unexpected,
  replace: unexpected, remove: unexpected, splice: unexpected,
}
