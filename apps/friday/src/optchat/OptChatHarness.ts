/* oxlint-disable anti-slop/no-runtime-typeof, effecttsgo/async-function, eslint/no-underscore-dangle -- Pi validates SDK message unions; Promise callbacks and schema discriminators are adapter boundaries. */
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { Message } from '@earendil-works/pi-ai'
import {
  CompactionTask,
  GenerationTask,
  LiveDoc,
  defineDoc,
  defineDocFamily,
  hook,
  type Conversation,
  type EntryRecord,
  type Harness,
} from '@earendil-works/pi-durable'
import { piOperation, runPiEffect } from '@friday/pi-durable-effect'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'
import { PromptMessageEnvelopeJson } from '../harness/pi/PromptMessage.ts'
import type { OptChatMemory, MemoryInput } from './OptChatMemory.ts'

type BindingState = {
  memoryId: string
  ranges: Array<{ start: number; end: number | null }>
}
const MemoryBinding = defineDoc({
  kind: 'friday.optchat-binding',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (): BindingState => ({ memoryId: '', ranges: [] }),
  checkpointWhen: () => true,
})
const RunView = defineDocFamily({
  kind: 'friday.optchat-run',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  family: true,
  initial: () => ({ view: '', inputEntry: 0 }),
  checkpointWhen: () => true,
})
const decodeEnvelope = Schema.decodeUnknownOption(PromptMessageEnvelopeJson)
const capResult = (text: string): string =>
  text.length <= 30_000
    ? text
    : `${text.slice(0, 15_000)}\n[Tool result truncated for memory]\n${text.slice(-15_000)}`

export const memoryEntries = (entries: readonly EntryRecord[]): MemoryInput[] =>
  entries.flatMap((entry) => {
    if (
      !entry.kind.startsWith('pi.') ||
      entry.kind === 'pi.system' ||
      entry.kind === 'pi.compaction'
    )
      return []
    return (entry.model ?? []).flatMap((message, messageIndex): MemoryInput[] => {
      const sourceKey = `${entry.id}:${messageIndex}`
      const date = DateTime.formatIso(DateTime.makeUnsafe(message.timestamp))
      if (message.role === 'user') {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content
                .flatMap((part) =>
                  part.type === 'text' ? [part.text] : [`[image:${part.mimeType}]`],
                )
                .join('\n')
        const envelope = decodeEnvelope(text)
        const userText = envelope._tag === 'Some' ? envelope.value.trigger.content : text
        return [
          {
            sourceKey,
            kind: text.startsWith('Background work for the earlier request ') ? 'work' : 'user',
            text: userText,
            date,
          },
        ]
      }
      if (message.role === 'toolResult')
        return [
          {
            sourceKey,
            kind: 'echo',
            text: capResult(
              message.content
                .map((part) => (part.type === 'text' ? part.text : `[image:${part.mimeType}]`))
                .join('\n'),
            ),
            date,
          },
        ]
      if (message.role !== 'assistant') return []
      return message.content.flatMap((part, index): MemoryInput[] =>
        part.type === 'thinking'
          ? []
          : [
              {
                sourceKey: `${sourceKey}:${index}`,
                kind: part.type === 'toolCall' ? 'tool' : 'talk',
                text:
                  part.type === 'text'
                    ? part.text
                    : `${part.name} ${JSON.stringify(part.arguments)}`,
                date,
              },
            ],
      )
    })
  })

export const makeOptChatHarness = (memory: OptChatMemory, getHarness: () => Harness) => {
  const entries = Effect.fn('OptChat.entries')(function* (conversation: Conversation) {
    const result: EntryRecord[] = []
    let cursor: import('@earendil-works/pi-durable').Cursor | undefined
    do {
      const page = yield* piOperation('optchat-history', (context) =>
        conversation.entries({}, 100, cursor, context),
      )
      result.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return result.toReversed()
  })
  const activate = Effect.fn('OptChat.activate')(function* (
    conversation: Conversation,
    memoryId: string,
  ) {
    const history = yield* entries(conversation)
    yield* piOperation('optchat-bind', (context) =>
      conversation.commit(async (tx) => {
        const binding = await tx.doc(MemoryBinding, conversation.id)
        if (binding.memoryId !== '' && binding.memoryId !== memoryId)
          throw new Error('This conversation already belongs to another OptChat memory.')
        if (binding.memoryId === '') {
          binding.memoryId = memoryId
        }
        if (binding.ranges.at(-1)?.end !== null) {
          binding.ranges.push({ start: history.at(-1)?.id ?? 0, end: null })
        }
      }, context),
    )
  })
  const deactivate = Effect.fn('OptChat.deactivate')(function* (conversation: Conversation) {
    const existing = yield* piOperation('optchat-binding', (context) =>
      getHarness().snapshot(MemoryBinding, conversation.id, context),
    )
    if (existing?.ranges.at(-1)?.end !== null) return
    const history = yield* entries(conversation)
    yield* piOperation('optchat-disable', (context) =>
      conversation.commit(async (tx) => {
        const binding = await tx.doc(MemoryBinding, conversation.id)
        const range = binding.ranges.at(-1)
        if (range?.end === null) range.end = history.at(-1)?.id ?? range.start
      }, context),
    )
  })
  const sync = Effect.fn('OptChat.sync')(function* (
    conversation: Conversation,
    memoryId: string,
    before?: number,
  ) {
    const binding = yield* piOperation('optchat-binding', (context) =>
      getHarness().snapshot(MemoryBinding, conversation.id, context),
    )
    if (binding?.memoryId !== memoryId)
      return yield* new PiDurableError({
        operation: 'optchat-sync',
        detail: 'Memory ownership mismatch.',
      })
    const history = yield* entries(conversation)
    yield* memory.append(
      memoryId,
      memoryEntries(
        history.filter(
          (entry) =>
            binding.ranges.some(
              (range) => entry.id > range.start && (range.end === null || entry.id <= range.end),
            ) &&
            (before === undefined || entry.id < before),
        ),
      ),
    )
    return history
  })
  const hooks = (memoryId: string) => [
    hook(CompactionTask, { beforeCompact: () => ({ decline: true }) }),
    hook(GenerationTask, {
      beforeRequest: (request, api, context) =>
        runPiEffect(
          Effect.gen(function* () {
            const harness = getHarness()
            const conversation = yield* piOperation('optchat-conversation', () =>
              harness.conversation(api.conversationId, context),
            )
            const live = yield* piOperation('optchat-run', () =>
              harness.snapshot(LiveDoc, api.conversationId, context),
            )
            const run = live?.run
            if (conversation === undefined || run === undefined)
              return yield* new PiDurableError({
                operation: 'optchat-request',
                detail: 'Missing active run.',
              })
            // Pi hands the run to new generation tasks after tools; its first input stays stable.
            const submissionId = run.inputs[0]
            if (submissionId === undefined)
              return yield* new PiDurableError({
                operation: 'optchat-request',
                detail: 'Missing first run submission.',
              })
            const key = String(submissionId)
            const saved = yield* piOperation('optchat-view', () =>
              harness.snapshot(RunView, conversation.id, key, context),
            )
            let firstEntry = saved?.inputEntry ?? 0
            let view = saved?.view ?? ''
            if (view === '') {
              const submission = yield* piOperation('optchat-submission', () =>
                harness.submission(submissionId, context),
              )
              const record =
                submission === undefined
                  ? undefined
                  : yield* piOperation('optchat-submission', () => submission.status(context))
              if (record === undefined || !('entry' in record) || record.entry === undefined)
                return yield* new PiDurableError({
                  operation: 'optchat-request',
                  detail: 'Missing first input entry.',
                })
              firstEntry = record.entry
              yield* sync(conversation, memoryId, firstEntry)
              view = yield* memory.settle(memoryId).pipe(
                Effect.tapError((cause) => Effect.logWarning('optchat.summary-wait', cause)),
                Effect.retry(Schedule.spaced('10 seconds')),
              )
              const frozen = yield* piOperation('optchat-freeze', () =>
                conversation.commit(async (tx) => {
                  const doc = await tx.doc(RunView, conversation.id, key, null)
                  if (doc.view === '') {
                    doc.view = view
                    doc.inputEntry = firstEntry
                  }
                  return { view: doc.view, inputEntry: doc.inputEntry }
                }, context),
              )
              view = frozen.view
              firstEntry = frozen.inputEntry
            }
            // Use the exact Pi request tail so provider reasoning and steering remain intact.
            const history = yield* entries(conversation)
            const firstMessage = history
              .find((entry) => entry.id === firstEntry)
              ?.model?.find((message) => message.role === 'user')
            const start = request.messages.findIndex(
              (message) =>
                message.role === 'user' &&
                firstMessage !== undefined &&
                message.timestamp === firstMessage.timestamp &&
                JSON.stringify(message.content) === JSON.stringify(firstMessage.content),
            )
            if (start < 0)
              return yield* new PiDurableError({
                operation: 'optchat-request',
                detail: 'The request no longer contains the active run input.',
              })
            const system: Message[] = [
              {
                role: 'system',
                content: getCurrentSystemPrompt(request.messages),
                toolsAdded: getCurrentTools(request.messages),
                timestamp: 0,
              },
            ]
            const tail = request.messages.slice(start)
            const initial = tail[0]
            if (initial?.role !== 'user')
              return yield* new PiDurableError({
                operation: 'optchat-request',
                detail: 'Expected the active user input.',
              })
            const content =
              typeof initial.content === 'string'
                ? [{ type: 'text' as const, text: initial.content }]
                : initial.content
            const messages: Message[] = [
              ...system,
              { ...initial, content: [{ type: 'text', text: view }, ...content] },
              ...tail.slice(1),
            ]
            yield* sync(conversation, memoryId)
            return { messages }
          }),
          context,
        ),
    }),
  ]
  return { activate, deactivate, sync, hooks }
}
