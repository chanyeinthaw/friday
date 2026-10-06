/* oxlint-disable anti-slop/no-runtime-typeof -- Pi session JSONL is an untrusted adapter boundary; SDK message unions need runtime discrimination. */
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { PromptMessageEnvelopeJson } from '../harness/pi/PromptMessage.ts'
import type { MemoryInput, OptChatMemory } from './OptChatMemory.ts'

export class OptChatImportError extends Schema.Error<OptChatImportError>('OptChatImportError')({
  _tag: Schema.tag('OptChatImportError'),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `OptChat Pi import failed: ${this.detail}`
  }
}

export const isOptChatImportError = Schema.is(OptChatImportError)

export interface PiImportOutcome {
  readonly memoryId: string
  readonly sessionId: string
  readonly total: number
  readonly imported: number
  readonly skipped: number
  readonly dryRun: boolean
}

/** Renders the import result for human CLI output; `--json` prints the outcome object. */
export const formatImportOutcome = (outcome: PiImportOutcome): string =>
  outcome.dryRun
    ? `Would import ${outcome.imported} messages into '${outcome.memoryId}' from session ${outcome.sessionId} (${outcome.skipped} already present).`
    : `Imported ${outcome.imported} messages into '${outcome.memoryId}' from session ${outcome.sessionId} (${outcome.skipped} skipped).`

const TrimmedString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
const JsonLine = Schema.fromJsonString(Schema.Unknown)
const decodeJsonLine = Schema.decodeUnknownEffect(JsonLine)

// Pi session format confirmed against `@earendil-works/pi-coding-agent` 1.0.2
// `core/session-manager.ts`: a `session` header first, then append-only entries
// with `id`/`parentId` tree links. The active branch is the leaf-to-root path
// from the last file entry (`getBranch`/`buildSessionPath`). Compaction-aware
// helpers (`buildContextEntries`, `buildSessionProjection`) replace compacted
// history with summaries, so import walks the full branch path instead and
// skips compaction entries to keep original text.
const SessionHeaderSchema = Schema.Struct({
  type: Schema.Literal('session'),
  id: TrimmedString,
  timestamp: Schema.String,
  cwd: Schema.String,
  version: Schema.optionalKey(Schema.Unknown),
  parentSession: Schema.optionalKey(Schema.Unknown),
})
const MessageEntrySchema = Schema.Struct({
  type: Schema.Literal('message'),
  id: TrimmedString,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  message: Schema.Unknown,
})
const ContextEditSchema = Schema.Struct({
  type: Schema.Literal('context_edit'),
  id: TrimmedString,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  targetId: TrimmedString,
  replacement: Schema.Unknown,
})
const OtherEntrySchema = Schema.Struct({
  type: Schema.String,
  id: TrimmedString,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
})
const SessionEntrySchema = Schema.Union([MessageEntrySchema, ContextEditSchema, OtherEntrySchema])
const decodeHeader = Schema.decodeUnknownEffect(SessionHeaderSchema)
const decodeEntry = Schema.decodeUnknownEffect(SessionEntrySchema)
const AnyMessage = Schema.Struct({
  role: Schema.String,
  timestamp: Schema.optional(Schema.Unknown),
  content: Schema.Unknown,
})
const decodeAnyMessage = Schema.decodeUnknownEffect(AnyMessage)
const EditReplacement = Schema.Union([Schema.Null, Schema.Struct({ content: Schema.Unknown })])
const decodeReplacement = Schema.decodeUnknownEffect(EditReplacement)
const SourceKeyRow = Schema.Struct({ sourceKey: Schema.String })
const decodeSourceKeyRows = Schema.decodeUnknownEffect(Schema.Array(SourceKeyRow))

type ParsedEntry = typeof SessionEntrySchema.Type

const decodeEnvelope = Schema.decodeUnknownOption(PromptMessageEnvelopeJson)
const capResult = (text: string): string =>
  text.length <= 30_000
    ? text
    : `${text.slice(0, 15_000)}\n[Tool result truncated for memory]\n${text.slice(-15_000)}`

const invalid = (detail: string, cause?: unknown): OptChatImportError =>
  cause === undefined
    ? new OptChatImportError({ detail })
    : new OptChatImportError({ detail, cause })

/** Requires an existing enabled binding; import never creates memories. */
export const requireEnabledBinding = Effect.fn('OptChatPiImport.binding')(function* (
  bindings: ReadonlyArray<{ readonly id: string; readonly enabled: number }>,
  memoryId: string,
) {
  const binding = bindings.find((candidate) => candidate.id === memoryId)
  if (binding === undefined) {
    return yield* invalid(`Memory '${memoryId}' is not bound. Add an OptChat binding first.`)
  }
  if (binding.enabled !== 1) {
    return yield* invalid(`Memory '${memoryId}' is disabled. Re-enable its binding first.`)
  }
})

/** Validates every JSONL line and the session header; no database access. */
export const parsePiSessionFile = Effect.fn('OptChatPiImport.parse')(function* (content: string) {
  const numbered = content
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== '')
  if (numbered.length === 0) return yield* invalid('Session file is empty.')
  const [head, ...tail] = numbered
  if (head === undefined) return yield* invalid('Session file is empty.')
  const headerJson = yield* decodeJsonLine(head.line).pipe(
    Effect.mapError((cause) => invalid(`Invalid JSON on line ${head.number}.`, cause)),
  )
  const header = yield* decodeHeader(headerJson).pipe(
    Effect.mapError((cause) => invalid(`Missing session header on line ${head.number}.`, cause)),
  )
  const entries: Array<ParsedEntry> = []
  for (const { line, number } of tail) {
    const json = yield* decodeJsonLine(line).pipe(
      Effect.mapError((cause) => invalid(`Invalid JSON on line ${number}.`, cause)),
    )
    const entry = yield* decodeEntry(json).pipe(
      Effect.mapError((cause) => invalid(`Invalid session entry on line ${number}.`, cause)),
    )
    if (entry.type === 'session') {
      return yield* invalid(`Unexpected session header on line ${number}.`)
    }
    entries.push(entry)
  }
  return { header, entries }
})

/** Selects the active branch: the leaf-to-root path from the last file entry. */
export const selectActiveBranch = (entries: readonly ParsedEntry[]): ParsedEntry[] => {
  const leaf = entries[entries.length - 1]
  if (leaf === undefined) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path: Array<ParsedEntry> = []
  const seen = new Set<string>()
  let current: ParsedEntry | undefined = leaf
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return path.reverse()
}

const formatDate = Effect.fn('OptChatPiImport.date')(function* (
  timestamp: unknown,
  entryId: string,
) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return yield* invalid(`Invalid timestamp for entry ${entryId}.`)
  }
  const made = DateTime.make(timestamp)
  if (Option.isNone(made)) return yield* invalid(`Invalid timestamp for entry ${entryId}.`)
  return DateTime.formatIso(made.value)
})

const userText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: Array<string> = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const record = part as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
    } else if (record['type'] === 'image' && typeof record['mimeType'] === 'string') {
      parts.push(`[image:${record['mimeType']}]`)
    }
  }
  return parts.join('\n')
}

const toolResultText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  const parts: Array<string> = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) return undefined
    const record = part as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
    } else if (record['type'] === 'image' && typeof record['mimeType'] === 'string') {
      parts.push(`[image:${record['mimeType']}]`)
    } else {
      return undefined
    }
  }
  return parts.join('\n')
}

// Maps one validated branch to memory inputs, reusing the OptChat projection:
// plain user text with envelope unwrapping, tool calls and results, reasoning
// exclusion, image placeholders, and message timestamps. Compaction,
// branch-summary, system, and extension messages are skipped so summaries never
// replace original text. Context edits apply to their target's content.
export const mapBranchToInputs = Effect.fn('OptChatPiImport.map')(function* (
  sessionId: string,
  branch: readonly ParsedEntry[],
) {
  const edits = new Map<string, { readonly content: unknown } | null>()
  for (const entry of branch) {
    if (entry.type !== 'context_edit') continue
    if (!('targetId' in entry) || !('replacement' in entry)) {
      return yield* invalid(`Invalid context edit for entry ${entry.id}.`)
    }
    const replacement = yield* decodeReplacement(entry.replacement).pipe(
      Effect.mapError((cause) => invalid(`Invalid context edit for entry ${entry.id}.`, cause)),
    )
    edits.set(entry.targetId, replacement)
  }
  const inputs: Array<MemoryInput> = []
  for (const entry of branch) {
    if (entry.type !== 'message') continue
    if (!('message' in entry)) {
      return yield* invalid(`Invalid message for entry ${entry.id}.`)
    }
    const raw = yield* decodeAnyMessage(entry.message).pipe(
      Effect.mapError((cause) => invalid(`Invalid message for entry ${entry.id}.`, cause)),
    )
    if (
      raw.role !== 'user' &&
      raw.role !== 'assistant' &&
      raw.role !== 'toolResult' &&
      raw.role !== 'system'
    )
      continue
    if (raw.role === 'system') continue
    const edit = edits.get(entry.id)
    if (edit === null) continue
    let content: unknown = raw.content
    if (edit !== undefined) {
      content =
        (raw.role === 'assistant' || raw.role === 'toolResult') && typeof edit.content === 'string'
          ? [{ type: 'text', text: edit.content }]
          : edit.content
    }
    const date = yield* formatDate(raw.timestamp, entry.id)
    const baseKey = `pi-import:${sessionId}:${entry.id}:0`
    if (raw.role === 'user') {
      const text = userText(content)
      if (text === undefined) {
        return yield* invalid(`Invalid user content for entry ${entry.id}.`)
      }
      const envelope = decodeEnvelope(text)
      const userContent = envelope._tag === 'Some' ? envelope.value.trigger.content : text
      inputs.push({
        sourceKey: baseKey,
        kind: text.startsWith('Background work for the earlier request ') ? 'work' : 'user',
        text: userContent,
        date,
      })
      continue
    }
    if (raw.role === 'toolResult') {
      const text = toolResultText(content)
      if (text === undefined) {
        return yield* invalid(`Invalid tool result for entry ${entry.id}.`)
      }
      inputs.push({ sourceKey: baseKey, kind: 'echo', text: capResult(text), date })
      continue
    }
    if (!Array.isArray(content)) {
      return yield* invalid(`Invalid assistant content for entry ${entry.id}.`)
    }
    content.forEach((part, partIndex) => {
      if (typeof part !== 'object' || part === null) return
      const record = part as Record<string, unknown>
      if (record['type'] === 'thinking') return
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        inputs.push({
          sourceKey: `${baseKey}:${partIndex}`,
          kind: 'talk',
          text: record['text'],
          date,
        })
      } else if (
        record['type'] === 'toolCall' &&
        typeof record['name'] === 'string' &&
        'arguments' in record
      ) {
        inputs.push({
          sourceKey: `${baseKey}:${partIndex}`,
          kind: 'tool',
          text: `${record['name']} ${JSON.stringify(record['arguments'])}`,
          date,
        })
      }
    })
  }
  return inputs
})

/** Validates the file and maps the active branch; completes before any writes. */
export const mapPiSessionContent = Effect.fn('OptChatPiImport.mapFile')(function* (
  content: string,
) {
  const parsed = yield* parsePiSessionFile(content)
  const branch = selectActiveBranch(parsed.entries)
  const inputs = yield* mapBranchToInputs(parsed.header.id, branch)
  return { sessionId: parsed.header.id, inputs }
})

// Stores mapped inputs with the existing whole-append atomic transaction
// (per-memory semaphore plus one SQLite transaction in `OptChatMemory.append`).
// Only inputs with new source keys reach the transaction; reimports of the same
// or a grown session deduplicate on `pi-import:<sessionId>:<entryId>:<indexes>`.
export const importMappedInputs = Effect.fn('OptChatPiImport.store')(function* (
  memory: OptChatMemory,
  memoryId: string,
  sessionId: string,
  inputs: readonly MemoryInput[],
  dryRun: boolean,
) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT source_key AS sourceKey FROM optchat_messages WHERE memory_id = ${memoryId} AND source_key LIKE ${`pi-import:${sessionId}:%`}`.pipe(
      Effect.mapError((cause) => invalid('Could not check existing imports.', cause)),
    )
  const decoded = yield* decodeSourceKeyRows(rows).pipe(
    Effect.mapError((cause) => invalid('Could not decode existing imports.', cause)),
  )
  const existing = new Set(decoded.map((row) => row.sourceKey))
  const fresh = inputs.filter((input) => !existing.has(input.sourceKey))
  if (!dryRun && fresh.length > 0) {
    yield* memory
      .append(memoryId, fresh)
      .pipe(Effect.mapError((cause) => invalid('Could not append imported messages.', cause)))
  }
  return {
    memoryId,
    sessionId,
    total: inputs.length,
    imported: fresh.length,
    skipped: inputs.length - fresh.length,
    dryRun,
  } satisfies PiImportOutcome
})
