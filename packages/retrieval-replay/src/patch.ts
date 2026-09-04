import {
  RetrievalError,
  type RetrievalState,
  type RetrievalStatePatch,
  type RetrievalStatePatchOperation,
} from '@retrieval-agent/contracts'

function fail(message: string): never {
  throw new RetrievalError('PROTOCOL_MISMATCH', message)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapePointer(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function diffValue(
  previous: unknown,
  next: unknown,
  path: string,
  operations: RetrievalStatePatchOperation[],
): void {
  if (Object.is(previous, next)) return
  if (Array.isArray(previous) && Array.isArray(next)) {
    const shared = Math.min(previous.length, next.length)
    for (let index = 0; index < shared; index += 1) {
      diffValue(previous[index], next[index], `${path}/${index}`, operations)
    }
    for (let index = previous.length - 1; index >= next.length; index -= 1) {
      operations.push({ op: 'remove', path: `${path}/${index}` })
    }
    for (let index = shared; index < next.length; index += 1) {
      operations.push({ op: 'add', path: `${path}/-`, value: next[index] })
    }
    return
  }
  if (plainObject(previous) && plainObject(next)) {
    const previousKeys = new Set(Object.keys(previous))
    const nextKeys = new Set(Object.keys(next))
    for (const key of [...previousKeys].filter(key => !nextKeys.has(key)).sort()) {
      operations.push({ op: 'remove', path: `${path}/${escapePointer(key)}` })
    }
    for (const key of [...nextKeys].sort()) {
      const child = `${path}/${escapePointer(key)}`
      if (!previousKeys.has(key)) operations.push({ op: 'add', path: child, value: next[key] })
      else diffValue(previous[key], next[key], child, operations)
    }
    return
  }
  operations.push({ op: 'replace', path, value: next })
}

function assertStateEdge(previous: RetrievalState, next: RetrievalState): void {
  if (previous.retrievalId !== next.retrievalId) fail('状态增量跨越了不同检索任务。')
  if (next.previousStateId !== previous.stateId || next.revision !== previous.revision + 1) {
    fail('状态增量没有连接相邻 revision。')
  }
}

/** Build a field/array-element delta; append-only candidate pages remain O(page-size). */
export function createRetrievalStatePatch(previous: RetrievalState, next: RetrievalState): RetrievalStatePatch {
  assertStateEdge(previous, next)
  const operations: RetrievalStatePatchOperation[] = []
  diffValue(previous, next, '', operations)
  if (operations.some(operation => operation.path.length === 0)) fail('状态增量不能替换根对象。')
  return {
    fromStateId: previous.stateId,
    fromRevision: previous.revision,
    toStateId: next.stateId,
    toRevision: next.revision,
    operations,
  }
}

const FORBIDDEN_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function pointerSegments(path: string): string[] {
  if (!path.startsWith('/') || path === '/') fail('状态增量包含无效 JSON Pointer。')
  return path.slice(1).split('/').map(segment => {
    if (/~(?!0|1)/u.test(segment)) fail('状态增量包含无效 JSON Pointer 转义。')
    const decoded = segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (FORBIDDEN_POINTER_SEGMENTS.has(decoded)) fail('状态增量包含禁止的对象路径。')
    return decoded
  })
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (segment === '-' && allowEnd) return length
  if (!/^(0|[1-9][0-9]*)$/u.test(segment)) fail('状态增量包含无效数组下标。')
  const index = Number(segment)
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) {
    fail('状态增量数组下标越界。')
  }
  return index
}

function parentAt(root: unknown, segments: readonly string[]): { readonly parent: unknown; readonly key: string } {
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length, false)]
    else if (plainObject(parent) && Object.hasOwn(parent, segment)) parent = parent[segment]
    else fail('状态增量引用了不存在的父路径。')
  }
  return { parent, key: segments.at(-1)! }
}

function applyOperation(root: unknown, operation: RetrievalStatePatchOperation): void {
  const { parent, key } = parentAt(root, pointerSegments(operation.path))
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, operation.op === 'add')
    if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value))
    else if (operation.op === 'replace') parent[index] = structuredClone(operation.value)
    else parent.splice(index, 1)
    return
  }
  if (!plainObject(parent)) fail('状态增量的目标父节点不是对象或数组。')
  if (operation.op === 'add') {
    if (Object.hasOwn(parent, key)) fail('状态增量 add 覆盖了已有字段。')
    parent[key] = structuredClone(operation.value)
  } else if (operation.op === 'replace') {
    if (!Object.hasOwn(parent, key)) fail('状态增量 replace 引用了不存在的字段。')
    parent[key] = structuredClone(operation.value)
  } else {
    if (!Object.hasOwn(parent, key)) fail('状态增量 remove 引用了不存在的字段。')
    delete parent[key]
  }
}

/** Apply one validated state-chain edge without executing retrieval policy. */
export function applyRetrievalStatePatch(previous: RetrievalState, patch: RetrievalStatePatch): RetrievalState {
  if (patch.fromStateId !== previous.stateId || patch.fromRevision !== previous.revision
    || patch.toRevision !== previous.revision + 1) fail('状态增量与当前 replay revision 不匹配。')
  // Session checkpoints are JSON values: two fields may share an in-memory array,
  // but patching one JSON path must never mutate another path through that alias.
  const next = JSON.parse(JSON.stringify(previous)) as RetrievalState
  for (const operation of patch.operations) applyOperation(next, operation)
  assertStateEdge(previous, next)
  if (next.stateId !== patch.toStateId || next.revision !== patch.toRevision) {
    fail('状态增量结果与声明的目标 revision 不一致。')
  }
  return next
}
