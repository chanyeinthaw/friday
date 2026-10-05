/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- Bun integration tests exercise the real durable scheduler and SQLite storage in temporary directories. */
import { test, expect } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  AgentThread,
  ChannelThread,
  HarnessSession,
  SteeringActivity,
  Turn,
} from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Schedule from 'effect/Schedule'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlatformOperationError } from '../../platforms/PlatformRegistry.ts'
import { RootUser } from '../../config/RootUsers.ts'
import { rootUsersForBinding } from '../../identity/RootUsers.ts'
import { DefaultIdentityText } from '../../config/IdentityConfiguration.ts'
import { runStructuralMigrations } from '../../persistence/Migrations.ts'
import { makeSqliteThreadPersistence } from '../../persistence/SqliteThreadPersistence.ts'
import { makeSystemPromptTemplates } from '../../system-prompt/SystemPromptTemplates.ts'
import { makePiDurable, type PiDurableOptions } from './PiDurable.ts'
import { makePiSqliteStorage } from '@friday/pi-durable-effect/sqlite'

const makeRootUser = Schema.decodeUnknownSync(RootUser)
const makeAgentThread = Schema.decodeUnknownSync(AgentThread)
const makeSession = Schema.decodeUnknownSync(HarnessSession)
const makeThread = Schema.decodeUnknownSync(ChannelThread)
const makeTurn = Schema.decodeUnknownSync(Turn)

const threadAt = (directory: string) =>
  makeThread({
    id: 'durable-thread',
    audience: 'user',
    parent: null,
    harness: 'pi-durable',
    harnessSession: null,
    workingDirectory: directory,
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'off',
    channelContext: { name: 'durable', description: '' },
    conversationBinding: {
      platform: 'test',
      connectionId: 'test',
      channelId: 'channel',
      sourceMessageId: 'message',
      conversationId: 'conversation',
    },
    status: 'active',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    closedAt: null,
  })
const turnFor = (thread: ChannelThread, id = 'durable-turn', sequence = 1) =>
  makeTurn({
    id,
    sequence,
    threadId: thread.id,
    input: { source: 'user', content: { text: 'Help with this repository.', images: [] } },
    agentMessage: null,
    activities: [],
    model: thread.model,
    thinkingLevel: thread.thinkingLevel,
    harnessTurnId: null,
    status: 'pending',
    requestedAt: '2026-10-05T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    usage: null,
  })

const withDatabase = <A, E>(
  use: (
    directory: string,
  ) => Effect.Effect<A, E, import('effect/unstable/sql/SqlClient').SqlClient | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-pi-durable-')))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        return yield* use(directory).pipe(
          Effect.provide(SqliteClient.layer({ filename: join(directory, 'friday.sqlite') })),
        )
      }),
    ),
  )

const fixture = Effect.fn('makeDurableFixture')(function* (directory: string) {
  yield* runStructuralMigrations()
  const persistence = yield* makeSqliteThreadPersistence()
  const thread = threadAt(directory)
  yield* persistence.createThread(thread)
  const faux = fauxProvider({ tokensPerSecond: Infinity })
  const models = createModels()
  models.setProvider(faux.provider)
  const published: string[] = []
  const delivered = yield* Deferred.make<void>()
  const options = {
    models,
    persistence,
    progress: {
      accept: () => Effect.void,
      observe: () => Effect.void,
      finalize: (_thread, _turn, text) =>
        Effect.sync(() => {
          published.push(text)
        }).pipe(Effect.andThen(Deferred.succeed(delivered, undefined))),
    },
    tasks: {
      start: () => Effect.die('unexpected'),
      bootstrap: () => Effect.die('unexpected'),
      steer: () => Effect.die('unexpected'),
      list: () => Effect.succeed([]),
      cancel: () => Effect.die('unexpected'),
      inspect: () => Effect.die('unexpected'),
      setModel: () => Effect.die('unexpected'),
    },
    platforms: {
      searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
    },
    templates: makeSystemPromptTemplates({
      channelAgent: 'Identity: {{identity}}\n{{rootUsers}}',
      bootstrapAgent: 'Bootstrap {{currentWorkingDirectory}}',
    }),
    availableAgentModels: () => [],
    identityText: () => Effect.succeed(DefaultIdentityText),
    rootUsers: () => Effect.succeed([]),
    loadResources: async () => ({
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    }),
  } satisfies Omit<PiDurableOptions, 'storage'>
  const openWith = (overrides: Partial<PiDurableOptions> = {}) =>
    Effect.gen(function* () {
      const sqlContext = yield* Layer.build(
        SqliteClient.layer({ filename: join(directory, 'pi-durable.sqlite') }),
      )
      const storage = yield* makePiSqliteStorage().pipe(Effect.provide(sqlContext))
      return yield* makePiDurable({ ...options, ...overrides, storage })
    })
  return { options, open: openWith(), openWith, persistence, thread, faux, published, delivered }
})

test('persists tool activities, answers, and idempotent submission receipts', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      yield* Effect.promise(() => writeFile(join(directory, 'input.txt'), 'expected file contents'))
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('read', { path: 'input.txt' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('The file contains expected file contents.'),
      ])
      const durable = yield* f.open
      yield* durable.recover
      const coordinator = yield* durable.openThread(f.thread)
      const turn = turnFor(f.thread)
      const first = yield* coordinator.prompt(turn)
      const terminal = yield* first.awaitTerminal
      expect(terminal.status).toBe('completed')
      expect(f.published).toEqual(['The file contains expected file contents.'])
      const stored = Option.getOrThrow(yield* f.persistence.getTurn(turn.id))
      expect(stored.activities.map((activity) => activity.type)).toEqual([
        'tool-call',
        'tool-result',
      ])
      expect(stored.status).toBe('completed')
      expect(stored.harnessTurnId).not.toBeNull()
      yield* (yield* coordinator.prompt(turn)).awaitTerminal
      expect(f.faux.state.callCount).toBe(2)
      expect(f.published).toHaveLength(1)
      expect(Option.getOrThrow(yield* f.persistence.getTurn(turn.id)).status).toBe('completed')
    }),
  ))

test('reopens SQLite and resumes an interrupted generation with reply delivery', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const started = yield* Deferred.make<void>()
      f.faux.setResponses([
        async (_context, options) => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Effect.never, { signal: options?.signal })
          return fauxAssistantMessage('unreachable')
        },
        fauxAssistantMessage('Recovered answer.'),
      ])
      const firstScope = yield* Scope.make()
      const first = yield* f.open.pipe(Scope.provide(firstScope))
      yield* first.recover
      yield* (yield* first.openThread(f.thread)).prompt(turnFor(f.thread))
      yield* Deferred.await(started)
      yield* Scope.close(firstScope, Exit.void)
      const second = yield* f.open
      yield* second.recover
      yield* Deferred.await(f.delivered)
      expect(f.published).toEqual(['Recovered answer.'])
      expect(Option.getOrThrow(yield* f.persistence.getLatestTurn(f.thread.id)).status).toBe(
        'completed',
      )
      expect(f.faux.state.callCount).toBe(2)
    }),
  ))

const steering = Schema.decodeUnknownSync(SteeringActivity)({
  id: 'steering-input',
  sequence: 0,
  status: 'completed',
  type: 'steering',
  message: { source: 'user', content: { text: 'Also explain the result.', images: [] } },
  createdAt: '2026-10-05T00:00:01.000Z',
  updatedAt: '2026-10-05T00:00:01.000Z',
  completedAt: '2026-10-05T00:00:01.000Z',
})

for (const shared of [true, false]) {
  test(
    shared
      ? 'steering shares one reply when consumed before the final answer'
      : 'steering receives its own reply when it becomes a successor run',
    () =>
      withDatabase((directory) =>
        Effect.gen(function* () {
          const f = yield* fixture(directory)
          yield* Effect.promise(() => writeFile(join(directory, 'input.txt'), 'contents'))
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          f.faux.setResponses([
            async () => {
              await Effect.runPromise(Deferred.succeed(started, undefined))
              await Effect.runPromise(Deferred.await(release))
              return shared
                ? fauxAssistantMessage(fauxToolCall('read', { path: 'input.txt' }), {
                    stopReason: 'toolUse',
                  })
                : fauxAssistantMessage('First answer.')
            },
            fauxAssistantMessage('Steered answer.'),
          ])
          const durable = yield* f.open
          yield* durable.recover
          const coordinator = yield* durable.openThread(f.thread)
          const first = yield* coordinator.prompt(turnFor(f.thread))
          yield* Deferred.await(started)
          yield* coordinator.steer(first.turnId, steering)
          yield* Deferred.succeed(release, undefined)
          yield* first.awaitTerminal
          const latest = Option.getOrThrow(yield* f.persistence.getLatestTurn(f.thread.id))
          yield* (yield* coordinator.prompt(latest)).awaitTerminal
          expect(f.published).toEqual(
            shared ? ['Steered answer.'] : ['First answer.', 'Steered answer.'],
          )
          expect(f.faux.state.callCount).toBe(2)
          expect(latest.sequence).toBe(2)
          expect(
            Option.getOrThrow(yield* f.persistence.getTurn(first.turnId)).activities.some(
              (activity) => activity.type === 'steering',
            ),
          ).toBe(true)
        }),
      ),
  )
}

test('retries a failed reply after restart without another model call', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const failed = yield* Deferred.make<void>()
      f.faux.setResponses([fauxAssistantMessage('Persisted answer.')])
      const firstScope = yield* Scope.make()
      const first = yield* f
        .openWith({
          progress: {
            ...f.options.progress,
            finalize: () =>
              Deferred.succeed(failed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new PlatformOperationError({ kind: 'test', cause: 'offline' })),
                ),
              ),
          },
        })
        .pipe(Scope.provide(firstScope))
      yield* first.recover
      yield* (yield* first.openThread(f.thread)).prompt(turnFor(f.thread))
      yield* Deferred.await(failed)
      yield* Scope.close(firstScope, Exit.void)
      const second = yield* f.open
      yield* second.recover
      yield* Deferred.await(f.delivered)
      expect(f.published).toEqual(['Persisted answer.'])
      expect(f.faux.state.callCount).toBe(1)
    }),
  ))

test('imports legacy context once without modifying the JSONL file', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const file = join(directory, 'legacy.jsonl')
      const bytes =
        [
          {
            type: 'session',
            version: 3,
            id: 'legacy',
            timestamp: '2026-10-01T00:00:00.000Z',
            cwd: directory,
          },
          {
            type: 'message',
            id: 'legacy-input',
            parentId: null,
            timestamp: '2026-10-01T00:00:00.000Z',
            message: { role: 'user', content: 'Remember the secret word orchid.', timestamp: 0 },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n'
      yield* Effect.promise(() => writeFile(file, bytes))
      yield* f.persistence.setThreadHarnessSession({
        threadId: f.thread.id,
        harnessSession: makeSession({ id: 'legacy', resumeCursor: { sessionFile: file } }),
      })
      const thread = makeThread(Option.getOrThrow(yield* f.persistence.getThread(f.thread.id)))
      f.faux.setResponses([
        async (context) => {
          expect(
            context.messages.filter(
              (message) =>
                message.role === 'user' && JSON.stringify(message.content).includes('orchid'),
            ),
          ).toHaveLength(1)
          return fauxAssistantMessage('Imported context.')
        },
      ])
      const durable = yield* f.open
      yield* durable.recover
      const coordinator = yield* durable.openThread(thread)
      yield* (yield* coordinator.prompt(turnFor(thread))).awaitTerminal
      yield* durable.openThread(thread)
      expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe(bytes)
    }),
  ))

const childFor = (parent: ChannelThread) =>
  makeAgentThread({
    ...parent,
    id: 'task-durable-child',
    audience: 'agent',
    parent: { threadId: parent.id, turnId: 'durable-turn' },
    role: 'subagent',
    subagentProfile: 'test',
    conversationBinding: null,
  })
const childTurnFor = (child: AgentThread) =>
  makeTurn({
    ...turnFor(threadAt(child.workingDirectory)),
    id: 'child-turn',
    threadId: child.id,
    input: { source: 'agent', content: { text: 'Inspect the repository.', images: [] } },
  })

test('recovers background work and submits one deterministic parent report', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const child = childFor(f.thread)
      yield* f.persistence.createThread(child)
      yield* f.persistence.createTurn(
        makeTurn({ ...turnFor(f.thread), status: 'completed', agentMessage: 'Delegated.' }),
      )
      const started = yield* Deferred.make<void>()
      const activity: string[] = []
      const titles = {
        generated: () => Effect.void,
        taskStarted: (
          _parent: ChannelThread,
          _id: import('@friday/contracts/conversation').TaskId,
          task?: string,
        ) =>
          Effect.sync(() => {
            activity.push(`started:${task}`)
          }),
        taskFinished: () =>
          Effect.sync(() => {
            activity.push('finished')
          }),
      }
      f.faux.setResponses([
        async (_context, options) => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Effect.never, { signal: options?.signal })
          return fauxAssistantMessage('unreachable')
        },
        fauxAssistantMessage('Child findings.'),
        async (context) => {
          expect(JSON.stringify(context.messages)).toContain('Child findings.')
          return fauxAssistantMessage('Parent report.')
        },
      ])
      const firstScope = yield* Scope.make()
      const first = yield* f
        .openWith({ conversationTitles: titles })
        .pipe(Scope.provide(firstScope))
      yield* first.recover
      yield* (yield* first.openThread(child)).prompt(childTurnFor(child))
      yield* Deferred.await(started)
      yield* Scope.close(firstScope, Exit.void)
      const secondScope = yield* Scope.make()
      const second = yield* f
        .openWith({ conversationTitles: titles })
        .pipe(Scope.provide(secondScope))
      yield* second.recover
      yield* Deferred.await(f.delivered)
      const parentReport = Option.getOrThrow(yield* f.persistence.getLatestTurn(f.thread.id))
      yield* (yield* (yield* second.openThread(f.thread)).prompt(parentReport)).awaitTerminal
      const childTurn = Option.getOrThrow(yield* f.persistence.getLatestTurn(child.id))
      yield* (yield* (yield* second.openThread(child)).prompt(childTurn)).awaitTerminal
      yield* Scope.close(secondScope, Exit.void)
      const third = yield* f.openWith({ conversationTitles: titles })
      yield* third.recover
      expect(f.published).toEqual(['Parent report.'])
      expect((yield* f.persistence.listTurns(f.thread.id)).map((turn) => String(turn.id))).toEqual([
        'durable-turn',
        'report-child-turn',
      ])
      expect(Option.getOrThrow(yield* f.persistence.getThread(child.id)).status).toBe('closed')
      expect(activity).toEqual(['started:Inspect the repository.', 'finished'])
      expect(f.faux.state.callCount).toBe(3)
    }),
  ))

test('cancels background work without submitting a late parent report', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const child = childFor(f.thread)
      yield* f.persistence.createThread(child)
      const started = yield* Deferred.make<void>()
      f.faux.setResponses([
        async (_context, options) => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Effect.never, { signal: options?.signal })
          return fauxAssistantMessage('unreachable')
        },
      ])
      const durable = yield* f.open
      yield* durable.recover
      const coordinator = yield* durable.openThread(child)
      const handle = yield* coordinator.prompt(childTurnFor(child))
      yield* Deferred.await(started)
      yield* coordinator.cancel(handle.turnId)
      expect((yield* handle.awaitTerminal).status).toBe('interrupted')
      expect(yield* f.persistence.listTurns(f.thread.id)).toEqual([])
      expect(f.published).toEqual([])
    }),
  ))

test('stale cancellation leaves a later active run intact', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      f.faux.setResponses([
        fauxAssistantMessage('First.'),
        async () => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Deferred.await(release))
          return fauxAssistantMessage('Second.')
        },
      ])
      const durable = yield* f.open
      yield* durable.recover
      const coordinator = yield* durable.openThread(f.thread)
      const first = yield* coordinator.prompt(turnFor(f.thread))
      yield* first.awaitTerminal
      const second = yield* coordinator.prompt(turnFor(f.thread, 'second-turn', 2))
      yield* Deferred.await(started)
      yield* coordinator.cancel(first.turnId)
      yield* Deferred.succeed(release, undefined)
      expect((yield* second.awaitTerminal).status).toBe('completed')
      expect(f.published).toEqual(['First.', 'Second.'])
    }),
  ))

test('does not replay an interrupted shell command after restart', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const count = join(directory, 'execution-count')
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('bash', { command: 'printf x >> execution-count\nsleep 30' }),
          { stopReason: 'toolUse' },
        ),
        async (context) => {
          expect(JSON.stringify(context.messages)).toContain('may have partially run')
          return fauxAssistantMessage('Recovered without repeating the command.')
        },
      ])
      const firstScope = yield* Scope.make()
      const first = yield* f.open.pipe(Scope.provide(firstScope))
      yield* first.recover
      yield* (yield* first.openThread(f.thread)).prompt(turnFor(f.thread))
      yield* Effect.tryPromise(() => readFile(count, 'utf8')).pipe(
        Effect.retry(Schedule.spaced('10 millis')),
        Effect.timeout('1 second'),
      )
      yield* Scope.close(firstScope, Exit.void)
      const second = yield* f.open
      yield* second.recover
      yield* Deferred.await(f.delivered)
      expect(yield* Effect.promise(() => readFile(count, 'utf8'))).toBe('x')
      expect(f.published).toEqual(['Recovered without repeating the command.'])
    }),
  ))

test('cancelling shared steering suppresses every child receipt report', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const child = childFor(f.thread)
      yield* f.persistence.createThread(child)
      yield* Effect.promise(() => writeFile(join(directory, 'input.txt'), 'contents'))
      const firstStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      f.faux.setResponses([
        async () => {
          await Effect.runPromise(Deferred.succeed(firstStarted, undefined))
          await Effect.runPromise(Deferred.await(release))
          return fauxAssistantMessage(fauxToolCall('read', { path: 'input.txt' }), {
            stopReason: 'toolUse',
          })
        },
        async (_context, options) => {
          await Effect.runPromise(Deferred.succeed(secondStarted, undefined))
          await Effect.runPromise(Effect.never, { signal: options?.signal })
          return fauxAssistantMessage('unreachable')
        },
      ])
      const durable = yield* f.open
      yield* durable.recover
      const coordinator = yield* durable.openThread(child)
      const first = yield* coordinator.prompt(childTurnFor(child))
      yield* Deferred.await(firstStarted)
      yield* coordinator.steer(first.turnId, steering)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(secondStarted)
      const latest = Option.getOrThrow(yield* f.persistence.getLatestTurn(child.id))
      yield* coordinator.cancel(latest.id)
      yield* first.awaitTerminal
      yield* (yield* coordinator.prompt(latest)).awaitTerminal
      expect((yield* f.persistence.listTurns(child.id)).map((turn) => turn.status)).toEqual([
        'interrupted',
        'interrupted',
      ])
      expect(yield* f.persistence.listTurns(f.thread.id)).toEqual([])
      expect(f.published).toEqual([])
    }),
  ))

test('channel prompts include scoped root users and resources while child prompts omit identities', () =>
  withDatabase((directory) =>
    Effect.gen(function* () {
      const f = yield* fixture(directory)
      const thread = makeThread({
        ...f.thread,
        id: 'scoped-thread',
        conversationBinding: {
          ...f.thread.conversationBinding,
          platform: 'discord',
          scopeId: 'guild-a',
        },
      })
      yield* f.persistence.createThread(thread)
      const roots = [
        makeRootUser({ platform: 'discord', scopeId: 'guild-a', userId: 'trusted-user' }),
        makeRootUser({ platform: 'discord', scopeId: 'guild-b', userId: 'other-scope-user' }),
      ]
      let rejectResourceLoad = false
      let appendSource = 'Append sentinel'
      let reloadedSystem = ''
      let childSystem = ''
      let channelSystem = ''
      let channelTools: string[] = []
      let childTools: string[] = []
      f.faux.setResponses([
        async (context) => {
          channelSystem = getCurrentSystemPrompt(context.messages)
          channelTools = getCurrentTools(context.messages)
            .map((tool) => tool.name)
            .sort()
          return fauxAssistantMessage('Channel answer.')
        },
        async (context) => {
          childSystem = getCurrentSystemPrompt(context.messages)
          childTools = getCurrentTools(context.messages)
            .map((tool) => tool.name)
            .sort()
          return fauxAssistantMessage('Child answer.')
        },
        fauxAssistantMessage('Reported child answer.'),
        async (context) => {
          reloadedSystem = getCurrentSystemPrompt(context.messages)
          return fauxAssistantMessage('Reloaded answer.')
        },
      ])
      const durable = yield* f.openWith({
        rootUsers: (thread) =>
          Effect.succeed(rootUsersForBinding(roots, thread.conversationBinding)),
        loadResources: async () => {
          if (rejectResourceLoad) throw new Error('Resource reload failed')
          const loadedAppend = appendSource
          return {
            ...(await f.options.loadResources()),
            getSystemPrompt: () => 'Loaded SYSTEM sentinel',
            getAppendSystemPrompt: () => [loadedAppend],
            getAgentsFiles: () => ({
              agentsFiles: [{ path: 'AGENTS.md', content: 'Repository instructions sentinel' }],
            }),
          }
        },
      })
      yield* durable.recover
      const coordinator = yield* durable.openThread(thread)
      yield* (yield* coordinator.prompt(turnFor(thread))).awaitTerminal
      const child = childFor(thread)
      yield* f.persistence.createThread(child)
      yield* (yield* (yield* durable.openThread(child)).prompt(childTurnFor(child))).awaitTerminal
      const report = Option.getOrThrow(yield* f.persistence.getLatestTurn(thread.id))
      yield* (yield* coordinator.prompt(report)).awaitTerminal
      expect(f.faux.state.callCount).toBe(3)
      expect(channelSystem.startsWith('Loaded SYSTEM sentinel')).toBe(true)
      expect(channelSystem).toContain('<addendum>\nAppend sentinel\n</addendum>')
      expect(channelSystem).toContain('<project_context>')
      expect(channelSystem).toContain('<project_instructions path="AGENTS.md">')
      expect(channelSystem).toContain(`<cwd>\n${thread.workingDirectory}\n</cwd>`)
      expect(channelSystem).toContain('<friday>')
      expect(channelTools).toEqual(['bash', 'edit', 'messages', 'read', 'task', 'write'])
      expect(childTools).toEqual(['bash', 'edit', 'read', 'write'])
      expect(channelSystem).toContain('trusted-user')
      expect(channelSystem).not.toContain('other-scope-user')
      expect(channelSystem).toContain(DefaultIdentityText)
      expect(childSystem).not.toContain('trusted-user')
      expect(childSystem).not.toContain(DefaultIdentityText)
      appendSource = 'Updated append sentinel'
      expect(yield* durable.reloadHarness(thread.id)).toEqual({ ok: true })
      yield* (yield* coordinator.prompt(turnFor(thread, 'reload-turn', 3))).awaitTerminal
      expect(reloadedSystem).toContain('<addendum>\nUpdated append sentinel\n</addendum>')
      expect(reloadedSystem).not.toContain('<addendum>\nAppend sentinel\n</addendum>')
      rejectResourceLoad = true
      expect(yield* durable.reloadHarness(thread.id)).toMatchObject({
        ok: false,
        reason: 'reload-failed',
      })
    }),
  ))
