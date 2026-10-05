import {
  buildResourcePrompt,
  loadPiResources,
  type PiResources,
} from '@friday/pi-durable-effect/resources'
import {
  codingTools,
  createToolRegistry,
  openHarness,
  piOperation,
  runPiEffect,
} from '@friday/pi-durable-effect'
/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Promise callbacks implement the Pi SDK boundary; filesystem resources are loaded by Pi's discovery utilities. */
import { findOptChatBinding } from '../../optchat/OptChatBindings.ts'
import { makeOptChatHarness } from '../../optchat/OptChatHarness.ts'
import { makeOptChatTools } from '../../optchat/OptChatTools.ts'
import { optChatInstructions } from '../../optchat/OptChatPrompt.ts'
import type { OptChatMemory } from '../../optchat/OptChatMemory.ts'
import { withOptChatCache } from '../../optchat/OptChatCache.ts'
import * as Schedule from 'effect/Schedule'
import type { Context as PiContext } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  buildSessionContext,
  parseSessionEntries,
  migrateSessionEntries,
} from '@earendil-works/pi-coding-agent'
import type { Models } from '@earendil-works/pi-ai'
import {
  type Harness,
  configure,
  defineTask,
  LiveDoc,
  type PromptInput,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Storage,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import {
  HarnessSessionId,
  HarnessTurnId,
  TaskId,
  Thread,
  Turn,
  TurnId,
  type ThreadId,
  type SteeringActivity,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import { readFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import {
  harnessReloadFailed,
  harnessReloadRefused,
  harnessReloadSucceeded,
  SteerRejectedError,
  type ConversationEvent,
  type HarnessReloadOutcome,
} from '../../conversation/ConversationEvents.ts'
import type { ChannelProgressContract } from '../../conversation/ChannelProgress.ts'
import type {
  ThreadCoordinatorContract,
  TerminalTurn,
} from '../../conversation/ThreadCoordinator.ts'
import type {
  ThreadPersistenceContract,
  ThreadPersistenceError,
} from '../../conversation/ThreadPersistence.ts'
import type { AppConfig } from '../../config/AppConfig.ts'
import type { IdentityText } from '../../config/IdentityConfiguration.ts'
import type { RootUser } from '../../config/RootUsers.ts'
import type { PlatformRegistryContract } from '../../platforms/PlatformRegistry.ts'
import type { ConversationTitlesContract } from '../../platforms/ConversationTitles.ts'
import { makeUserFacingPlatformTools } from '../../platforms/UserPlatformTools.ts'
import { fridaySkillPathsForAudience } from '../../skills/FridaySkills.ts'
import {
  renderModelHint,
  type SystemPromptTemplatesContract,
} from '../../system-prompt/SystemPromptTemplates.ts'
import { makePiTaskTool, type PiTaskOperations } from '../../tasks/PiTaskTool.ts'
import { renderTaskOutcome } from '../../tasks/TaskCompletion.ts'
import { FridayConversation, FridayThreads, FridayTurn } from './PiDurableDocuments.ts'
import { PiDurableError, type PiRuntimeObservation } from './PiDurableError.ts'
import { projectPiActivities } from './PiDurableProjection.ts'
import { renderPromptMessage } from './PromptMessage.ts'
import { refreshSharedModelRuntime } from './PiModelRefresh.ts'

const threadCodec = Schema.fromJsonString(Thread)
const turnCodec = Schema.fromJsonString(Turn)
const decodeThread = Schema.decodeSync(threadCodec)
const encodeThread = Schema.encodeSync(threadCodec)
const decodeTurn = Schema.decodeSync(turnCodec)
const makeTurn = Schema.decodeUnknownSync(Turn)
const encodeTurn = Schema.encodeSync(turnCodec)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeSessionId = Schema.decodeSync(HarnessSessionId)
const decodeHarnessTurnId = Schema.decodeSync(HarnessTurnId)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))
const legacyCursor = Schema.decodeUnknownOption(Schema.Struct({ sessionFile: Schema.String }))

export interface PiDurableOptions {
  readonly optChat?: {
    readonly memory: OptChatMemory
    readonly bindings: () => AppConfig['agent']['optChats']
  }
  readonly storage: Storage
  readonly models: Models
  readonly persistence: ThreadPersistenceContract
  readonly progress: ChannelProgressContract
  readonly tasks: PiTaskOperations
  readonly platforms: Pick<
    PlatformRegistryContract,
    'searchMessages' | 'getMessage' | 'postMessage' | 'listMembers' | 'discoverPlatforms'
  >
  readonly templates: SystemPromptTemplatesContract
  readonly availableAgentModels: () => AppConfig['models']['subagents']
  readonly identityText: () => Effect.Effect<IdentityText>
  readonly rootUsers: (
    thread: Extract<Thread, { audience: 'user' }>,
  ) => Effect.Effect<ReadonlyArray<RootUser>>
  readonly conversationTitles?: ConversationTitlesContract
  readonly loadResources?: (thread: Thread) => Promise<PiResources>
}

type Coordinator = ThreadCoordinatorContract<PiDurableError, PiDurableError>

export interface PiDurableContract {
  readonly openThread: (
    thread: Thread,
  ) => Effect.Effect<Coordinator, PiDurableError | ThreadPersistenceError>
  readonly observe: (threadId: ThreadId) => Effect.Effect<PiRuntimeObservation>
  readonly reloadHarness: (threadId: ThreadId) => Effect.Effect<HarnessReloadOutcome>
  /** Called after platform adapters and task dispatch are installed, before accepting inbound work. */
  readonly recover: Effect.Effect<void, PiDurableError | ThreadPersistenceError>
}

export class PiDurable extends Context.Service<PiDurable, PiDurableContract>()(
  'friday/pi/PiDurable',
) {}

const terminalTurn = (turn: Turn): TerminalTurn => {
  if (turn.status === 'completed')
    return {
      status: 'completed',
      turnId: turn.id,
      agentMessage: turn.agentMessage ?? '',
      usage: turn.usage,
    }
  if (turn.status === 'interrupted')
    return {
      status: 'interrupted',
      turnId: turn.id,
      agentMessage: turn.agentMessage,
      usage: turn.usage,
    }
  return { status: 'failed', turnId: turn.id, errorMessage: turn.errorMessage ?? 'Pi run failed.' }
}

/** Failed runs have no answer cursor; stop before an input belonging to a successor generation. */
const runHistory = (entries: readonly EntryRecord[]) => {
  const runTaskId = entries.find((entry) => entry.kind === 'pi.assistant')?.byTaskId
  const boundary = entries.findIndex(
    (entry, index) =>
      index > 0 &&
      entry.kind === 'pi.user' &&
      (entry.byTaskId === undefined || entry.byTaskId !== runTaskId),
  )
  return boundary < 0 ? entries : entries.slice(0, boundary)
}

const completedTurn = (
  original: Turn,
  settled: import('@earendil-works/pi-durable').SettledSubmissionRecord & { type: 'input' },
  entries: readonly EntryRecord[],
  now: number,
): Turn => {
  const runEntries = settled.status === 'done' ? entries : runHistory(entries)
  const messages = runEntries
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === 'assistant')
  const answer =
    settled.status === 'done'
      ? entries
          .find((entry) => entry.id === settled.answer)
          ?.model?.find((message) => message.role === 'assistant')
      : messages.at(-1)
  const totals = messages.reduce(
    (usage, message) => ({
      inputTokens: usage.inputTokens + message.usage.input,
      outputTokens: usage.outputTokens + message.usage.output,
      totalTokens: usage.totalTokens + message.usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  )
  const text =
    answer?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? null
  const completedAt = new Date(now).toISOString()
  const status =
    settled.status === 'done'
      ? 'completed'
      : settled.reason === 'aborted' || settled.reason === 'withdrawn'
        ? 'interrupted'
        : 'failed'
  return makeTurn({
    ...original,
    status,
    harnessTurnId: decodeHarnessTurnId(String(settled.id)),
    agentMessage: text,
    usage: totals,
    startedAt: original.startedAt ?? original.requestedAt,
    completedAt,
    errorMessage:
      status === 'failed' ? (settled.status === 'unanswered' ? settled.reason : null) : null,
  })
}

type CompletionCheckpoint =
  | { phase: 'wait' }
  | { phase: 'deliver'; turnJson: string; shared: boolean; attempt: number; retryAt: number }

export const makePiDurable = Effect.fn('PiDurable.open')(function* (options: PiDurableOptions) {
  const ready = yield* Deferred.make<void>()
  const toolRegistry = createToolRegistry()
  const { registry } = toolRegistry
  const scope = yield* Effect.scope
  const locks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (threadId: string) => {
    const existing = locks.get(threadId)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    locks.set(threadId, created)
    return created
  }
  const projectionLock = yield* PartitionedSemaphore.make<string>({ permits: 1 })
  const listeners = new Map<ThreadId, Set<(event: ConversationEvent) => Effect.Effect<void>>>()
  const watching = new Set<ThreadId>()
  // Assigned once before any submission or scheduler is admitted.
  let harness: Harness

  const emit = Effect.fn('PiDurable.emit')(function* (thread: Thread, event: ConversationEvent) {
    if (thread.audience === 'user')
      yield* options.progress.observe(thread.id, event).pipe(Effect.ignore)
    yield* Effect.forEach(listeners.get(thread.id) ?? [], (listener) => listener(event), {
      discard: true,
    })
  })

  const currentThread = Effect.fn('PiDurable.currentThread')(function* (thread: Thread) {
    const found = yield* options.persistence.getThread(thread.id)
    return Option.getOrElse(found, () => thread)
  })

  const optChat =
    options.optChat === undefined
      ? undefined
      : makeOptChatHarness(options.optChat.memory, () => harness)
  const optChatFor = (thread: Thread) =>
    thread.audience === 'user'
      ? findOptChatBinding(options.optChat?.bindings(), thread.conversationBinding)
      : undefined
  const workerThreads = new Set<ThreadId>()
  const registerThread = Effect.fn('PiDurable.registerThread')(function* (thread: Thread) {
    const binding = optChatFor(thread)
    const customLoader = options.loadResources
    const resources = yield* Effect.cached(
      customLoader === undefined
        ? loadPiResources({
            cwd: thread.workingDirectory,
            additionalSkillPaths: fridaySkillPathsForAudience(thread.audience),
          })
        : piOperation('load-resources', () => customLoader(thread)),
    )
    // Match Pi's eager reload so failed resource discovery cannot report a successful reload.
    yield* resources
    const prompt = Effect.fn('PiDurable.systemPrompt')(function* (input: PromptInput) {
      const current = yield* currentThread(thread)
      const loader = yield* resources
      let base =
        'You are Friday, a coding assistant. Use the available tools to complete the request.'
      if (current.audience === 'user') {
        base = yield* options.templates.renderChannelAgent({
          thread: current,
          optChat: binding !== undefined,
          availableAgentModels: options.availableAgentModels(),
          identityText: yield* options.identityText(),
          rootUsers: yield* options.rootUsers(current),
        })
      } else if (current.role === 'bootstrap') {
        base = yield* options.templates.renderBootstrapAgent(current.workingDirectory)
      } else base += `\n\n${renderModelHint(current)}`
      if (binding !== undefined) base += `\n\n${optChatInstructions}`
      // A discovered SYSTEM.md remains the preamble; Friday policies remain an independent section.
      const resourceOptions = {
        cwd: current.workingDirectory,
        selectedTools: input.agent.tools.map((tool) => tool.name),
        fallbackPrompt: base,
      }
      return yield* buildResourcePrompt(
        loader,
        loader.getSystemPrompt() !== undefined
          ? { ...resourceOptions, sections: { friday: base } }
          : resourceOptions,
      )
    })
    const tools =
      thread.audience === 'user'
        ? [
            ...makeUserFacingPlatformTools({
              thread,
              platforms: options.platforms,
            }),
            makePiTaskTool({
              thread,
              tasks: options.tasks,
              activeTurnId: Effect.gen(function* () {
                const index = yield* piOperation('active-turn', (context) =>
                  harness.snapshot(FridayThreads, context),
                )
                const id = index?.threads.find(
                  (item) => item.threadId === thread.id,
                )?.conversationId
                if (id === undefined) return null
                const live = yield* piOperation('active-turn', (context) =>
                  harness.snapshot(LiveDoc, id, context),
                )
                const input = live?.run?.inputs[0]
                if (input === undefined) return null
                const submission = yield* piOperation('active-turn', (context) =>
                  harness.submission(input, context),
                )
                const record =
                  submission === undefined
                    ? undefined
                    : yield* piOperation('active-turn', (context) => submission.status(context))
                return record?.requestId === undefined ? null : decodeTurnId(record.requestId)
              }),
            }),
          ]
        : []
    return yield* toolRegistry.provide(`friday:${thread.id}`, {
      tools: [
        ...codingTools,
        ...tools,
        ...(binding === undefined || options.optChat === undefined
          ? []
          : makeOptChatTools(options.optChat.memory, binding.id)),
      ],
      hooks: binding === undefined ? [] : (optChat?.hooks(binding.id) ?? []),
      systemPrompt: prompt,
    })
  })

  const findConversation = Effect.fn('PiDurable.findConversation')(function* (threadId: ThreadId) {
    const index = yield* piOperation('find-conversation', (context) =>
      harness.snapshot(FridayThreads, context),
    )
    const id = index?.threads.find((item) => item.threadId === threadId)?.conversationId
    if (id === undefined) return undefined
    return yield* piOperation('find-conversation', (context) => harness.conversation(id, context))
  })

  const project = (
    thread: Thread,
    turnId: TurnId,
    entries: readonly EntryRecord[],
    tools: Parameters<typeof projectPiActivities>[0]['tools'],
  ) =>
    projectionLock.withPermit(thread.id)(
      projectPiActivities({
        thread,
        turnId,
        entries,
        tools,
        persistence: options.persistence,
        emit: (event) => emit(thread, event),
      }),
    )

  const watch = Effect.fn('PiDurable.watch')(function* (
    thread: Thread,
    conversation: Conversation,
  ) {
    if (watching.has(thread.id)) return
    const subscription = yield* piOperation('watch', () => conversation.watch(BACKGROUND_CONTEXT))
    watching.add(thread.id)
    const update = Effect.fn('PiDurable.updateProjection')(function* (
      view: typeof subscription.value,
    ) {
      const binding = optChatFor(thread)
      if (binding !== undefined && optChat !== undefined)
        yield* optChat.syncObserved(conversation, binding.id)
      const live = yield* piOperation('projection', (context) =>
        harness.snapshot(LiveDoc, conversation.id, context),
      )
      const input = live?.run?.inputs[0]
      if (input === undefined) return
      const handle = yield* piOperation('projection', (context) =>
        harness.submission(input, context),
      )
      const submission =
        handle === undefined
          ? undefined
          : yield* piOperation('projection', (context) => handle.status(context))
      if (
        submission?.type !== 'input' ||
        submission.entry === undefined ||
        submission.requestId === undefined
      )
        return
      const firstEntry = submission.entry
      yield* project(
        thread,
        decodeTurnId(submission.requestId),
        view.entries.filter((entry) => entry.id >= firstEntry),
        live?.tools ?? [],
      )
    })
    subscription.start((view) =>
      Effect.runPromise(
        update(view).pipe(
          Effect.catchCause((cause) => Effect.logWarning('pi.projection.failed', cause)),
        ),
      ),
    )
    yield* Scope.addFinalizer(scope, Effect.promise(() => subscription.stop()).pipe(Effect.asVoid))
    yield* update(subscription.value).pipe(Effect.ignore)
  })

  const history = Effect.fn('PiDurable.history')(function* (
    conversation: Conversation,
    start: EntryRecord['id'],
    context: PiContext,
    end?: EntryRecord['id'],
  ) {
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    do {
      const query =
        end === undefined ? { minEntryId: start } : { minEntryId: start, maxEntryId: end }
      const page = yield* piOperation('history', () =>
        conversation.entries(query, 100, cursor, context),
      )
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return entries.toReversed()
  })

  const sharesAnswer = Effect.fn('PiDurable.sharesAnswer')(function* (
    parent: import('@earendil-works/pi-durable').SettledSubmissionRecord | undefined,
    settled: import('@earendil-works/pi-durable').SettledSubmissionRecord & { type: 'input' },
    entries: readonly EntryRecord[],
    conversation: Conversation,
    context: PiContext,
  ) {
    if (parent?.type !== 'input') return false
    if (parent.status === 'done' && settled.status === 'done')
      return parent.answer === settled.answer
    if (
      parent.status !== 'unanswered' ||
      parent.entry === undefined ||
      settled.status !== 'unanswered'
    )
      return false
    const parentEntries = runHistory(yield* history(conversation, parent.entry, context))
    const parentTask = parentEntries.find((entry) => entry.kind === 'pi.assistant')?.byTaskId
    return parentTask !== undefined && entries[0]?.byTaskId === parentTask
  })

  const completeTurn = defineTask<{ turnId: string }, CompletionCheckpoint, string>({
    name: 'friday.complete-turn',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      wait: (task, runtime, context): Promise<void> =>
        runPiEffect(
          Effect.gen(function* () {
            const receipt = yield* piOperation('complete-turn', () =>
              runtime.snapshot(FridayTurn, runtime.conversationId, task.input.turnId, context),
            )
            const submissionId = receipt?.submissionId
            if (receipt === undefined || submissionId === null || submissionId === undefined)
              return yield* new PiDurableError({
                operation: 'complete-turn',
                detail: 'Missing Friday submission receipt.',
              })
            const submission = yield* piOperation('complete-turn', () =>
              harness.submission(submissionId, context),
            )
            if (submission === undefined)
              return yield* new PiDurableError({
                operation: 'complete-turn',
                detail: 'Missing Pi submission.',
              })
            const settled = yield* piOperation('complete-turn', () => submission.wait(context))
            if (settled.type !== 'input')
              return yield* new PiDurableError({
                operation: 'complete-turn',
                detail: 'Friday turn must refer to a Pi input.',
              })
            const original = decodeTurn(receipt.turnJson)
            const conversation = yield* piOperation('complete-turn', () =>
              harness.conversation(runtime.conversationId, context),
            )
            if (conversation === undefined)
              return yield* new PiDurableError({
                operation: 'complete-turn',
                detail: 'Missing Pi conversation.',
              })
            const parentTurnId = receipt.parentTurnId
            const parentReceipt =
              parentTurnId === null
                ? undefined
                : yield* piOperation('complete-turn', () =>
                    runtime.snapshot(FridayTurn, runtime.conversationId, parentTurnId, context),
                  )
            const parentSubmissionId = parentReceipt?.submissionId
            const parentSubmission =
              parentSubmissionId == null
                ? undefined
                : yield* piOperation('complete-turn', () =>
                    harness.submission(parentSubmissionId, context),
                  )
            const parent =
              parentSubmission === undefined
                ? undefined
                : yield* piOperation('complete-turn', () => parentSubmission.wait(context))
            const entries =
              settled.entry === undefined
                ? []
                : yield* history(
                    conversation,
                    settled.entry,
                    context,
                    settled.status === 'done' ? settled.answer : undefined,
                  )
            const shared = yield* sharesAnswer(parent, settled, entries, conversation, context)
            const turn = completedTurn(original, settled, entries, runtime.now())
            yield* piOperation('complete-turn', () =>
              runtime.commit(
                () => ({
                  status: 'running',
                  checkpoint: {
                    phase: 'deliver',
                    turnJson: encodeTurn(turn),
                    shared,
                    attempt: 0,
                    retryAt: 0,
                  },
                }),
                context,
              ),
            )
          }),
          context,
        ),
      deliver: (task, runtime, context): Promise<void> =>
        runPiEffect(
          Effect.gen(function* () {
            const checkpoint = task.state.checkpoint
            if (checkpoint.retryAt > runtime.now())
              yield* piOperation('complete-turn', () => runtime.sleep(checkpoint.retryAt, context))
            const turn = decodeTurn(checkpoint.turnJson)
            const receipt = yield* piOperation('complete-turn', () =>
              runtime.snapshot(FridayTurn, runtime.conversationId, turn.id, context),
            )
            if (receipt?.delivered) {
              yield* piOperation('complete-turn', () =>
                runtime.commit(
                  () => ({
                    status: 'terminal',
                    outcome: { status: 'completed', result: checkpoint.turnJson },
                  }),
                  context,
                ),
              )
              return
            }
            const outcome = yield* Effect.exit(
              lockFor(turn.threadId).withPermit(
                deliver(turn, runtime.conversationId, checkpoint.shared),
              ),
            )
            if (Exit.isFailure(outcome)) {
              if (context.abortSignal?.aborted) return
              runtime.report(outcome.cause)
              yield* piOperation('complete-turn', () =>
                runtime.commit(
                  () => ({
                    status: 'running',
                    checkpoint: {
                      ...checkpoint,
                      attempt: checkpoint.attempt + 1,
                      retryAt:
                        runtime.now() +
                        Math.min(60_000, 1000 * 2 ** Math.min(checkpoint.attempt, 6)),
                    },
                  }),
                  context,
                ),
              )
              return
            }
            yield* piOperation('complete-turn', () =>
              runtime.commit(async (tx) => {
                ;(
                  await tx.doc(
                    FridayTurn,
                    runtime.conversationId,
                    turn.id,
                    receipt?.turnJson ?? checkpoint.turnJson,
                  )
                ).delivered = true
                return {
                  status: 'terminal',
                  outcome: { status: 'completed', result: checkpoint.turnJson },
                }
              }, context),
            )
          }),
          context,
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
  yield* toolRegistry.provide('friday-completion', { tools: [], tasks: [completeTurn] })

  harness = yield* openHarness(options.storage, {
    models: withOptChatCache(options.models),
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? '.' }),
    onReport: (cause) => Effect.runSync(Effect.logError('pi.durable.report', cause)),
  })

  const ensureConversation = Effect.fn('PiDurable.ensureConversation')(function* (thread: Thread) {
    yield* refreshSharedModelRuntime(
      options.models,
      (failure) => new PiDurableError({ operation: 'refresh-models', ...failure }),
    )
    const loadout = yield* registerThread(thread)
    const indexed = yield* findConversation(thread.id)
    const legacy =
      thread.harnessSession === null
        ? Option.none()
        : legacyCursor(thread.harnessSession.resumeCursor)
    // The selected legacy branch and compaction summary become the new conversation's initial model context.
    const legacyMessages =
      indexed === undefined && Option.isSome(legacy)
        ? yield* Effect.gen(function* () {
            const content = yield* piOperation('read-session', () =>
              readFile(legacy.value.sessionFile, 'utf8'),
            )
            return yield* Effect.try({
              try: () => {
                // Validate every line before Pi's parser, which otherwise skips corrupt JSON.
                const lines = content.split('\n').filter((line) => line.trim().length > 0)
                for (const line of lines) decodeJsonLine(line)
                const entries = parseSessionEntries(content)
                if (entries[0]?.type !== 'session')
                  throw new Error('Legacy session is missing its header.')
                migrateSessionEntries(entries)
                return buildSessionContext(entries.filter((entry) => entry.type !== 'session'))
                  .messages
              },
              catch: (cause) => new PiDurableError({ operation: 'import-session', cause }),
            })
          })
        : []
    const id = yield* piOperation('create-conversation', (context) =>
      harness.commit(async (tx) => {
        const index = await tx.doc(FridayThreads)
        const existing = index.threads.find((item) => item.threadId === thread.id)
        if (existing !== undefined) return existing.conversationId
        const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await configure(tx, created.id, {
          model: thread.model,
          thinkingLevel: thread.thinkingLevel,
          cwd: thread.workingDirectory,
          ...loadout,
        })
        const state = await tx.doc(FridayConversation, created.id)
        state.threadJson = encodeThread(thread)
        for (const message of legacyMessages) {
          if (
            message.role === 'user' ||
            message.role === 'assistant' ||
            message.role === 'toolResult'
          ) {
            await tx.appendEntry(created.id, { kind: 'friday.imported', model: [message] })
          }
        }
        index.threads.push({ threadId: thread.id, conversationId: created.id })
        return created.id
      }, context),
    )
    const conversation = yield* piOperation('open-conversation', (context) =>
      harness.conversation(id, context),
    )
    if (conversation === undefined)
      return yield* new PiDurableError({
        operation: 'open-conversation',
        cause: 'Missing indexed conversation.',
      })
    const live = yield* piOperation('configure', (context) =>
      harness.snapshot(LiveDoc, id, context),
    )
    if (live?.run === undefined)
      yield* piOperation('configure', (context) =>
        conversation.configure(
          {
            ...loadout,
            model: thread.model,
            thinkingLevel: thread.thinkingLevel,
            cwd: thread.workingDirectory,
          },
          context,
        ),
      )
    yield* piOperation('save-thread', (context) =>
      conversation.commit(async (tx) => {
        const saved = await tx.doc(FridayConversation, id)
        saved.threadJson = encodeThread(thread)
      }, context),
    )
    yield* options.persistence.setThreadHarnessSession({
      threadId: thread.id,
      harnessSession: { id: decodeSessionId(String(id)), resumeCursor: { conversationId: id } },
    })
    const binding = optChatFor(thread)
    if (binding !== undefined && optChat !== undefined && options.optChat !== undefined) {
      yield* optChat.activate(conversation, binding.id)
      if (!workerThreads.has(thread.id)) {
        workerThreads.add(thread.id)
        yield* options.optChat.memory.pump(binding.id).pipe(
          Effect.tapError((cause) => Effect.logWarning('optchat.compactor.failed', cause)),
          Effect.ignore,
          Effect.repeat(Schedule.spaced('10 seconds')),
          Effect.forkIn(scope),
        )
      }
    }
    if (binding === undefined && optChat !== undefined && live?.run === undefined)
      yield* optChat.deactivate(conversation)
    yield* watch(thread, conversation)
    return conversation
  })

  const taskStarted = Effect.fn('PiDurable.taskStarted')(function* (thread: Thread, turn: Turn) {
    if (thread.audience === 'agent' && options.conversationTitles) {
      const parent = yield* options.persistence.getThread(thread.parent.threadId)
      const first = yield* options.persistence.getFirstTurn(thread.id)
      if (Option.isSome(parent) && parent.value.audience === 'user') {
        yield* options.conversationTitles
          .taskStarted(
            parent.value,
            decodeTaskId(thread.id),
            Option.isSome(first) ? first.value.input.content.text : turn.input.content.text,
          )
          .pipe(Effect.ignore)
      }
    }
  })

  const admit = Effect.fn('PiDurable.admit')(function* (
    thread: Thread,
    conversation: Conversation,
    requested: Turn,
    parentTurnId: string | null = null,
  ) {
    const previousReceipt = yield* piOperation('receipt', (context) =>
      harness.snapshot(FridayTurn, conversation.id, requested.id, context),
    )
    const existing = yield* options.persistence.getTurn(requested.id)
    const latest = yield* options.persistence.getLatestTurn(thread.id)
    const turn = Option.isSome(existing)
      ? existing.value
      : makeTurn({ ...requested, sequence: Option.isSome(latest) ? latest.value.sequence + 1 : 1 })
    if (Option.isNone(existing)) {
      yield* options.persistence.createTurn(turn)
      if (thread.audience === 'user')
        yield* options.progress
          .accept(
            thread,
            turn.input,
            decodeTurnId(previousReceipt?.parentTurnId ?? parentTurnId ?? turn.id),
          )
          .pipe(Effect.ignore)
    }
    yield* piOperation('save-turn', (context) =>
      conversation.commit(async (tx) => {
        const receipt = await tx.doc(FridayTurn, conversation.id, turn.id, encodeTurn(turn))
        if (previousReceipt === undefined) receipt.parentTurnId = parentTurnId
      }, context),
    )
    if (previousReceipt === undefined && parentTurnId === null) yield* taskStarted(thread, turn)
    const submission = yield* piOperation('submit', (context) =>
      conversation.submit(
        {
          type: 'input',
          content: renderPromptMessage(turn.input),
          requestId: turn.id,
          whenBusy: (previousReceipt?.parentTurnId ?? parentTurnId) === null ? 'followUp' : 'steer',
        },
        context,
      ),
    )
    if (
      previousReceipt?.completionTaskId === null ||
      previousReceipt?.completionTaskId === undefined
    ) {
      yield* options.persistence.startTurn({
        turnId: turn.id,
        harnessTurnId: decodeHarnessTurnId(String(submission.id)),
        startedAt: turn.startedAt ?? turn.requestedAt,
      })
    }
    const completionTaskId = yield* piOperation('schedule-completion', (context) =>
      conversation.commit(async (tx) => {
        const receipt = await tx.doc(FridayTurn, conversation.id, turn.id, encodeTurn(turn))
        receipt.submissionId = submission.id
        if (receipt.completionTaskId === null)
          receipt.completionTaskId = await tx.createTask(
            completeTurn,
            { turnId: turn.id },
            { ownership: { kind: 'conversation' }, background: true },
          )
        return receipt.completionTaskId
      }, context),
    )
    return {
      turnId: turn.id,
      awaitTerminal: Effect.gen(function* () {
        const completed = yield* piOperation('await-completion', (context) =>
          harness.waitForTask(completionTaskId, context),
        )
        if (completed.state.outcome.status !== 'completed')
          return yield* new PiDurableError({
            operation: 'await-completion',
            detail: `Friday completion ${completed.state.outcome.status}.`,
          })
        return terminalTurn(decodeTurn(completed.state.outcome.result))
      }),
    }
  })

  const projectTerminal = Effect.fn('PiDurable.projectTerminal')(function* (
    thread: Thread,
    turn: Turn,
    conversation: Conversation,
    conversationId: ConversationId,
  ) {
    const receipt = yield* piOperation('submission', (context) =>
      harness.snapshot(FridayTurn, conversationId, turn.id, context),
    )
    const submissionId = receipt?.submissionId
    const submission =
      submissionId === null || submissionId === undefined
        ? undefined
        : yield* piOperation('submission', (context) => harness.submission(submissionId, context))
    const record =
      submission === undefined
        ? undefined
        : yield* piOperation('submission', (context) => submission.status(context))
    if (record?.entry !== undefined) {
      const firstEntry = record.entry
      const entries = yield* history(
        conversation,
        firstEntry,
        BACKGROUND_CONTEXT,
        record.status === 'done' ? record.answer : undefined,
      )
      yield* project(thread, turn.id, record.status === 'done' ? entries : runHistory(entries), [])
      const binding = optChatFor(thread)
      if (
        binding !== undefined &&
        optChat !== undefined &&
        record.type === 'input' &&
        record.status === 'done'
      )
        yield* optChat.sync(conversation, binding.id, record.answer + 1)
    }
  })

  const finishAgent = Effect.fn('PiDurable.finishAgent')(function* (
    thread: Extract<Thread, { audience: 'agent' }>,
    completedAt: Turn['requestedAt'],
  ) {
    const turns = yield* options.persistence.listTurns(thread.id)
    if (turns.some((turn) => turn.status === 'pending' || turn.status === 'running')) return
    yield* options.persistence.closeThread({ threadId: thread.id, closedAt: completedAt })
    const parent = yield* options.persistence.getThread(thread.parent.threadId)
    if (Option.isSome(parent) && parent.value.audience === 'user' && options.conversationTitles) {
      yield* options.conversationTitles
        .taskFinished(parent.value, decodeTaskId(thread.id))
        .pipe(Effect.ignore)
    }
  })

  const deliver = Effect.fn('PiDurable.deliver')(function* (
    turn: Turn,
    conversationId: ConversationId,
    shared: boolean,
  ) {
    const found = yield* options.persistence.getThread(turn.threadId)
    if (Option.isNone(found))
      return yield* new PiDurableError({ operation: 'deliver', cause: 'Missing Friday thread.' })
    const thread = found.value
    const conversation = yield* piOperation('deliver', (context) =>
      harness.conversation(conversationId, context),
    )
    if (conversation === undefined)
      return yield* new PiDurableError({ operation: 'deliver', cause: 'Missing Pi conversation.' })
    yield* projectTerminal(thread, turn, conversation, conversationId)
    const completedAt = turn.completedAt ?? turn.requestedAt
    if (turn.status === 'completed')
      yield* options.persistence.completeTurn({
        turnId: turn.id,
        agentMessage: turn.agentMessage ?? '',
        usage: turn.usage,
        completedAt,
      })
    else if (turn.status === 'interrupted')
      yield* options.persistence.interruptTurn({
        turnId: turn.id,
        agentMessage: turn.agentMessage,
        usage: turn.usage,
        completedAt,
      })
    else
      yield* options.persistence.failTurn({
        turnId: turn.id,
        errorMessage: turn.errorMessage ?? 'Pi run failed.',
        completedAt,
      })
    if (thread.audience === 'agent') yield* finishAgent(thread, completedAt)
    if (shared) return
    if (thread.audience === 'user') {
      const text =
        turn.status === 'completed'
          ? (turn.agentMessage ?? '')
          : turn.status === 'interrupted'
            ? (turn.agentMessage ?? 'Work was interrupted before a response was ready.')
            : `Work failed: ${turn.errorMessage}`
      yield* options.progress.finalize(thread, turn.id, text)
      return
    }
    const parent = yield* options.persistence.getThread(thread.parent.threadId)
    if (Option.isNone(parent) || parent.value.audience !== 'user') return
    const receipt = yield* piOperation('cancellation', (context) =>
      harness.snapshot(FridayTurn, conversationId, turn.id, context),
    )
    if (!receipt?.cancelled) {
      const parentThread = parent.value
      const reportId = decodeTurnId(`report-${turn.id}`)
      const previous = yield* options.persistence.getTurn(reportId)
      const latest = yield* options.persistence.getLatestTurn(parentThread.id)
      const timestamp = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
      const report: Turn = Option.getOrElse(previous, () => ({
        id: reportId,
        threadId: parentThread.id,
        sequence: Option.isSome(latest) ? latest.value.sequence + 1 : 1,
        input: {
          source: 'agent',
          content: { text: renderTaskOutcome(terminalTurn(turn)), images: [] },
        },
        agentMessage: null,
        activities: [],
        model: parentThread.model,
        thinkingLevel: parentThread.thinkingLevel,
        harnessTurnId: null,
        status: 'pending',
        requestedAt: timestamp,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        usage: null,
      }))
      const coordinator = yield* openThread(parentThread)
      yield* coordinator.prompt(report)
    }
  })

  const reloadHarness = Effect.fn('PiDurable.reloadHarness')(
    function* (threadId: ThreadId) {
      const found = yield* options.persistence.getThread(threadId)
      if (Option.isNone(found))
        return harnessReloadRefused(
          'unknown-thread',
          'No Friday thread is bound to this conversation.',
        )
      const conversation = yield* findConversation(threadId)
      if (conversation === undefined)
        return harnessReloadRefused('no-runtime', 'No Pi conversation exists for this thread yet.')
      const live = yield* piOperation('reload', (context) =>
        harness.snapshot(LiveDoc, conversation.id, context),
      )
      if (live?.run !== undefined)
        return harnessReloadRefused(
          'busy',
          'A turn is active in this thread; wait for it to finish before reloading.',
        )
      const loadout = yield* registerThread(found.value)
      yield* piOperation('reload', (context) =>
        conversation.configure(
          { ...loadout, model: found.value.model, thinkingLevel: found.value.thinkingLevel },
          context,
        ),
      )
      return harnessReloadSucceeded()
    },
    (effect) =>
      effect.pipe(Effect.catch((cause) => Effect.succeed(harnessReloadFailed(String(cause))))),
  )

  const openThread = Effect.fn('PiDurable.openThread')(function* (thread: Thread) {
    const conversation = yield* lockFor(thread.id)
      .withPermit(ensureConversation(thread))
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof PiDurableError
            ? cause
            : new PiDurableError({ operation: 'open', cause }),
        ),
      )
    return {
      prompt: (turn: Turn) => lockFor(thread.id).withPermit(admit(thread, conversation, turn)),
      steer: (turnId: TurnId, activity: SteeringActivity) =>
        lockFor(thread.id).withPermit(
          Effect.gen(function* () {
            const receipt = yield* piOperation('steer', (context) =>
              harness.snapshot(FridayTurn, conversation.id, turnId, context),
            )
            const live = yield* piOperation('steer', (context) =>
              harness.snapshot(LiveDoc, conversation.id, context),
            )
            const submission =
              receipt?.submissionId == null
                ? undefined
                : yield* piOperation('steer', (context) =>
                    harness.submission(receipt.submissionId!, context),
                  )
            const record =
              submission === undefined
                ? undefined
                : yield* piOperation('steer', (context) => submission.status(context))
            if (
              live?.run === undefined ||
              record === undefined ||
              (record.status !== 'queued' && record.status !== 'placed')
            ) {
              return yield* new PiDurableError({
                operation: 'steer',
                cause: new SteerRejectedError({
                  turnId,
                  detail: 'No active Pi run for this Turn.',
                }),
              })
            }
            const parentSubmission = yield* piOperation('steer', (context) =>
              harness.submission(live.run!.inputs[0]!, context),
            )
            const parent =
              parentSubmission === undefined
                ? undefined
                : yield* piOperation('steer', (context) => parentSubmission.status(context))
            yield* options.persistence.putActivitySnapshot(turnId, activity)
            const turn = makeTurn({
              id: `steer:${activity.id}`,
              threadId: thread.id,
              sequence: 1,
              input: activity.message,
              agentMessage: null,
              activities: [],
              model: thread.model,
              thinkingLevel: thread.thinkingLevel,
              harnessTurnId: null,
              status: 'pending',
              requestedAt: activity.createdAt,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              usage: null,
            })
            yield* admit(thread, conversation, turn, parent?.requestId ?? turnId)
          }),
        ),
      cancel: (turnId: TurnId) =>
        lockFor(thread.id).withPermit(
          Effect.gen(function* () {
            const receipt = yield* piOperation('cancel', (context) =>
              harness.snapshot(FridayTurn, conversation.id, turnId, context),
            )
            const submissionId = receipt?.submissionId
            if (submissionId == null || receipt?.delivered) return
            const submission = yield* piOperation('cancel', (context) =>
              harness.submission(submissionId, context),
            )
            if (submission === undefined) return
            const status = yield* piOperation('cancel', (context) => submission.status(context))
            const live = yield* piOperation('cancel', (context) =>
              harness.snapshot(LiveDoc, conversation.id, context),
            )
            const run = live?.run
            const active =
              run !== undefined &&
              (run.inputs.includes(submission.id) ||
                (thread.audience === 'agent' && status.status === 'queued'))
                ? run
                : undefined
            const records = yield* Effect.forEach(
              active?.inputs ?? [],
              (id) =>
                Effect.gen(function* () {
                  const input = yield* piOperation('cancel', (context) =>
                    harness.submission(id, context),
                  )
                  return input === undefined
                    ? undefined
                    : yield* piOperation('cancel', (context) => input.status(context))
                }),
              { concurrency: 'unbounded' },
            )
            yield* piOperation('cancel', (context) =>
              conversation.commit(async (tx) => {
                const receipt = await tx.doc(FridayTurn, conversation.id, turnId, '')
                receipt.cancelled = true
                for (const record of records) {
                  if (record?.requestId === undefined) continue
                  const input = await tx.doc(FridayTurn, conversation.id, record.requestId, '')
                  input.cancelled = true
                }
              }, context),
            )
            yield* piOperation('cancel', (context) => submission.abort(context))
            if (active !== undefined)
              yield* piOperation('cancel', (context) => harness.abortTask(active.taskId, context))
          }),
        ),
      reload: () => lockFor(thread.id).withPermit(reloadHarness(thread.id)),
      onEvent: (listener: (event: ConversationEvent) => Effect.Effect<void>) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const set = listeners.get(thread.id) ?? new Set()
            set.add(listener)
            listeners.set(thread.id, set)
          }),
          () =>
            Effect.sync(() => {
              listeners.get(thread.id)?.delete(listener)
            }),
        ).pipe(Effect.asVoid),
    } satisfies Coordinator
  })

  const recover = Effect.gen(function* () {
    const index = yield* piOperation('recover', (context) =>
      harness.snapshot(FridayThreads, context),
    )
    for (const item of index?.threads ?? []) {
      const saved = yield* piOperation('recover', (context) =>
        harness.snapshot(FridayConversation, item.conversationId, context),
      )
      if (saved === undefined || saved.threadJson === '')
        return yield* new PiDurableError({
          operation: 'recover',
          detail: 'Missing conversation thread metadata.',
        })
      const found = yield* options.persistence.getThread(decodeThread(saved.threadJson).id)
      if (Option.isNone(found)) continue
      yield* registerThread(found.value)
    }
    for (const item of index?.threads ?? []) {
      const saved = yield* piOperation('recover', (context) =>
        harness.snapshot(FridayConversation, item.conversationId, context),
      )
      if (saved === undefined) continue
      const thread = yield* currentThread(decodeThread(saved.threadJson))
      const conversation = yield* ensureConversation(thread)
      const turns = yield* options.persistence.listTurns(thread.id)
      for (const turn of turns) {
        const receipt = yield* piOperation('recover', (context) =>
          harness.snapshot(FridayTurn, conversation.id, turn.id, context),
        )
        if (
          turn.status === 'pending' ||
          turn.status === 'running' ||
          (receipt !== undefined && !receipt.delivered)
        )
          yield* admit(thread, conversation, turn)
      }
    }
    yield* Effect.sync(() => harness.resume())
    yield* Deferred.succeed(ready, undefined)
  })

  return PiDurable.of({
    openThread: Effect.fn('PiDurable.openReadyThread')(function* (thread) {
      yield* Deferred.await(ready)
      return yield* openThread(thread)
    }),
    reloadHarness: Effect.fn('PiDurable.reloadReadyThread')(function* (threadId) {
      yield* Deferred.await(ready)
      return yield* lockFor(threadId).withPermit(reloadHarness(threadId))
    }),
    recover,
    observe: (threadId) =>
      Effect.gen(function* () {
        const conversation = yield* findConversation(threadId)
        if (conversation === undefined) return { runtimePresent: false, activeTurns: 0 }
        const live = yield* piOperation('observe', (context) =>
          harness.snapshot(LiveDoc, conversation.id, context),
        )
        return { runtimePresent: true, activeTurns: live?.run === undefined ? 0 : 1 }
      }).pipe(Effect.orElseSucceed(() => ({ runtimePresent: false, activeTurns: 0 }))),
  })
})
