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
  type: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (type) => (type !== 'message' && type !== 'context_edit') || 'Expected a metadata entry',
      ),
    ),
  ),
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
const ImportedRow = Schema.Struct({
  sourceKey: Schema.String,
  text: Schema.String,
  kind: Schema.String,
  date: Schema.String,
})
const decodeImportedRows = Schema.decodeUnknownEffect(Schema.Array(ImportedRow))
const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })
const ImageBlock = Schema.Struct({
  type: Schema.Literal('image'),
  mimeType: Schema.String,
  data: Schema.String,
})
const TextContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([TextBlock, ImageBlock])),
])
const ResultContent = Schema.Array(Schema.Union([TextBlock, ImageBlock]))
const AssistantContent = Schema.Array(
  Schema.Union([
    TextBlock,
    Schema.Struct({ type: Schema.Literal('thinking'), thinking: Schema.String }),
    Schema.Struct({
      type: Schema.Literal('toolCall'),
      id: Schema.String,
      name: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ]),
)
const decodeTextContent = Schema.decodeUnknownEffect(TextContent)
const decodeResultContent = Schema.decodeUnknownEffect(ResultContent)
const decodeAssistantContent = Schema.decodeUnknownEffect(AssistantContent)
const decodeTimestamp = Schema.decodeUnknownEffect(Schema.Finite)

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
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) return yield* invalid(`Duplicate entry ID ${entry.id}.`)
    if (entry.parentId !== null && !seen.has(entry.parentId)) {
      return yield* invalid(`Entry ${entry.id} has a missing or forward parent ${entry.parentId}.`)
    }
    if (entry.type === 'context_edit' && 'targetId' in entry && !seen.has(entry.targetId)) {
      return yield* invalid(`Context edit ${entry.id} targets a missing or future entry.`)
    }
    seen.add(entry.id)
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
  return path.toReversed()
}

const formatDate = Effect.fn('OptChatPiImport.date')(function* (
  timestamp: (typeof AnyMessage.Type)['timestamp'],
  entryId: string,
) {
  const value = yield* decodeTimestamp(timestamp).pipe(
    Effect.mapError((cause) => invalid(`Invalid timestamp for entry ${entryId}.`, cause)),
  )
  const made = DateTime.make(value)
  if (Option.isNone(made)) return yield* invalid(`Invalid timestamp for entry ${entryId}.`)
  return DateTime.formatIso(made.value)
})

const textFromBlocks = (content: typeof ResultContent.Type): string =>
  content.map((part) => (part.type === 'text' ? part.text : `[image:${part.mimeType}]`)).join('\n')

const mapMessage = Effect.fn('OptChatPiImport.message')(function* (
  sessionId: string,
  entry: typeof MessageEntrySchema.Type,
  edit: typeof EditReplacement.Type | undefined,
) {
  const raw = yield* decodeAnyMessage(entry.message).pipe(
    Effect.mapError((cause) => invalid(`Invalid message for entry ${entry.id}.`, cause)),
  )
  if (!['user', 'assistant', 'toolResult'].includes(raw.role)) return []
  if (edit === null) return []
  const content = edit === undefined ? raw.content : edit.content
  const date = yield* formatDate(raw.timestamp, entry.id)
  const baseKey = `pi-import:${sessionId}:${entry.id}:0`
  if (raw.role === 'user') {
    const decoded = yield* decodeTextContent(content).pipe(
      Effect.mapError((cause) => invalid(`Invalid user content for entry ${entry.id}.`, cause)),
    )
    const text = typeof decoded === 'string' ? decoded : textFromBlocks(decoded)
    const envelope = decodeEnvelope(text)
    return [
      {
        sourceKey: baseKey,
        kind: text.startsWith('Background work for the earlier request ') ? 'work' : 'user',
        text: Option.isSome(envelope) ? envelope.value.trigger.content : text,
        date,
      },
    ] satisfies MemoryInput[]
  }
  // Pi normalizes string context edits to text blocks for assistant/tool messages.
  const normalized =
    edit !== undefined && typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (raw.role === 'toolResult') {
    const decoded = yield* decodeResultContent(normalized).pipe(
      Effect.mapError((cause) => invalid(`Invalid tool result for entry ${entry.id}.`, cause)),
    )
    return [
      { sourceKey: baseKey, kind: 'echo', text: capResult(textFromBlocks(decoded)), date },
    ] satisfies MemoryInput[]
  }
  const decoded = yield* decodeAssistantContent(normalized).pipe(
    Effect.mapError((cause) => invalid(`Invalid assistant content for entry ${entry.id}.`, cause)),
  )
  return decoded.flatMap((part, partIndex): MemoryInput[] => {
    if (part.type === 'thinking') return []
    return [
      {
        sourceKey: `${baseKey}:${partIndex}`,
        kind: part.type === 'text' ? 'talk' : 'tool',
        text: part.type === 'text' ? part.text : `${part.name} ${JSON.stringify(part.arguments)}`,
        date,
      },
    ]
  })
})

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
    inputs.push(...(yield* mapMessage(sessionId, entry, edits.get(entry.id))))
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
    yield* sql`SELECT source_key AS sourceKey, text, kind, date FROM optchat_messages WHERE memory_id = ${memoryId}`.pipe(
      Effect.mapError((cause) => invalid('Could not check existing imports.', cause)),
    )
  const decoded = yield* decodeImportedRows(rows).pipe(
    Effect.mapError((cause) => invalid('Could not decode existing imports.', cause)),
  )
  const incoming = new Map(inputs.map((input) => [input.sourceKey, input]))
  const prefix = `pi-import:${sessionId}:`
  for (const row of decoded) {
    if (!row.sourceKey.startsWith(prefix)) continue
    const input = incoming.get(row.sourceKey)
    if (
      input === undefined ||
      input.text !== row.text ||
      input.kind !== row.kind ||
      input.date !== row.date
    ) {
      return yield* invalid(
        `Session ${sessionId} conflicts with previously imported entry ${row.sourceKey}. Import into a separate memory; existing history is immutable.`,
      )
    }
  }
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
