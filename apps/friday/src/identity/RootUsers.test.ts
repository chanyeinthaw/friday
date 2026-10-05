/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Pi runtime capture uses a narrow ModelRuntime stub and Effect scoping is the explicit test boundary. */
import { assert, it } from '@effect/vitest'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import {
  ChannelThread,
  IsoDateTime,
  ModelSelection,
  SubagentProfileName,
  TurnId,
  WorkingDirectory,
  type Turn,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RootUser } from '../config/RootUsers.ts'
import { rootUsersForBinding, renderRootUsersSection } from './RootUsers.ts'
import {
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from '../system-prompt/SystemPromptTemplates.ts'
import { makeTasks } from '../tasks/Tasks.ts'
import { makeTaskModels } from '../tasks/TaskModels.ts'
import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import type { FridayContract } from '../Friday.ts'
import { harnessReloadSucceeded } from '../conversation/ConversationEvents.ts'

const decodeRootUser = Schema.decodeSync(RootUser)
const decodeThread = Schema.decodeSync(ChannelThread)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeWorkingDirectory = Schema.decodeSync(WorkingDirectory)
const decodeIsoDateTime = Schema.decodeSync(IsoDateTime)
const decodeModel = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)

const discordRootUserA = decodeRootUser({
  platform: 'discord',
  scopeId: '111111111111111111',
  userId: '222222222222222222',
})
const discordRootUserB = decodeRootUser({
  platform: 'discord',
  scopeId: '333333333333333333',
  userId: '444444444444444444',
})
const slackRootUserW = decodeRootUser({
  platform: 'slack',
  scopeId: 'T01234567',
  userId: 'U08987654',
})

const rootUserRegistry = [discordRootUserA, discordRootUserB, slackRootUserW]

const channelThreadFor = (
  conversationId: string,
  platform: 'discord' | 'slack' | 'test',
  scopeId?: string,
) =>
  decodeThread({
    id: 'thread-root-user',
    audience: 'user',
    parent: null,
    harness: 'pi-durable',
    harnessSession: null,
    workingDirectory: '/tmp/friday/root-user',
    model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'max',
    channelContext: { name: 'root-user-test', description: '' },
    conversationBinding:
      scopeId === undefined
        ? {
            platform,
            connectionId: 'test-connection',
            channelId: 'channel-root-user-test',
            sourceMessageId: 'message-root-user-test',
            conversationId,
          }
        : {
            platform,
            connectionId: 'test-connection',
            channelId: 'channel-root-user-test',
            sourceMessageId: 'message-root-user-test',
            conversationId,
            scopeId,
          },
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

const discordConversationA = 'discord:111111111111111111:999999999999999901:888888888888888881'
const discordBindingA = channelThreadFor(
  discordConversationA,
  'discord',
  '111111111111111111',
).conversationBinding
const discordBindingB = channelThreadFor(
  'discord:333333333333333333:999999999999999902',
  'discord',
  '333333333333333333',
).conversationBinding
const slackBindingW = channelThreadFor(
  'slack:C01234567:1710000000.000000',
  'slack',
  'T01234567',
).conversationBinding

it.effect('includes matching platform and guild root users in the channel scope', () =>
  Effect.gen(function* () {
    const scoped = rootUsersForBinding(rootUserRegistry, discordBindingA)
    assert.deepStrictEqual(scoped, [discordRootUserA])

    const section = renderRootUsersSection(scoped)
    assert.include(section, '222222222222222222')
    assert.include(section, '111111111111111111')

    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread: channelThreadFor(discordConversationA, 'discord', '111111111111111111'),
      identityText: 'Your name is Friday' as never,
      availableAgentModels: [],
      rootUsers: scoped,
    })
    assert.include(prompt, '222222222222222222')
    assert.include(prompt, 'Root user')
    assert.notInclude(prompt, '{{')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('excludes root users from another platform or guild workspace', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(rootUsersForBinding(rootUserRegistry, discordBindingB), [
      discordRootUserB,
    ])
    assert.deepStrictEqual(rootUsersForBinding(rootUserRegistry, slackBindingW), [slackRootUserW])

    const scopedA = rootUsersForBinding(rootUserRegistry, discordBindingA)
    const sectionA = renderRootUsersSection(scopedA)
    assert.notInclude(sectionA, '444444444444444444')
    assert.notInclude(sectionA, 'U08987654')

    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread: channelThreadFor(discordConversationA, 'discord', '111111111111111111'),
      identityText: 'Your name is Friday' as never,
      availableAgentModels: [],
      rootUsers: scopedA,
    })
    assert.notInclude(prompt, '444444444444444444')
    assert.notInclude(prompt, 'U08987654')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('does not leak the full rootUserRegistry to unscoped contexts', () =>
  Effect.gen(function* () {
    const testBinding = channelThreadFor('test-conversation', 'test').conversationBinding
    const dmBinding = channelThreadFor(
      'discord:@me:999999999999999901',
      'discord',
    ).conversationBinding
    assert.deepStrictEqual(rootUsersForBinding(rootUserRegistry, testBinding), [])
    assert.deepStrictEqual(rootUsersForBinding(rootUserRegistry, dmBinding), [])
    assert.deepStrictEqual(rootUsersForBinding([], discordBindingA), [])

    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread: channelThreadFor('test-conversation', 'test'),
      identityText: 'Your name is Friday' as never,
      availableAgentModels: [],
      rootUsers: [],
    })
    assert.include(prompt, '(No root users are configured for this channel scope.)')
    for (const leaked of ['222222222222222222', '444444444444444444', 'U08987654']) {
      assert.notInclude(prompt, leaked)
    }
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('leaves the initial task Turn byte-for-byte the caller task', () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-root-user-start-')))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    const fileSystem = yield* FileSystem.FileSystem
    const channelWorkspace = join(root, 'channel')
    const projectDirectory = join(channelWorkspace, 'project')
    yield* fileSystem.makeDirectory(projectDirectory, { recursive: true })
    yield* fileSystem.writeFileString(join(projectDirectory, '.keep'), '')

    const parent = decodeThread({
      id: 'thread-root-user-parent',
      audience: 'user',
      parent: null,
      harness: 'pi-durable',
      harnessSession: null,
      workingDirectory: channelWorkspace,
      model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
      thinkingLevel: 'max',
      channelContext: { name: 'root-user-task', description: '' },
      conversationBinding: {
        platform: 'discord',
        connectionId: 'test-connection',
        channelId: '999999999999999901',
        sourceMessageId: 'message-root-user-parent',
        conversationId: discordConversationA,
      },
      status: 'active',
      createdAt: '2026-03-21T09:00:00.000Z',
      updatedAt: '2026-03-21T09:00:00.000Z',
      closedAt: null,
    })
    const taskText = 'Inspect the repository and report the result.'
    const promptedTurns: Array<Turn> = []
    const persistence: ThreadPersistenceContract = {
      createThread: () => Effect.void,
      getThread: (threadId) =>
        Effect.succeed(threadId === parent.id ? Option.some(parent) : Option.none()),
      findPlatformThread: () => Effect.succeedNone,
      listAgentThreads: () => Effect.succeed([]),
      closeThread: () => Effect.void,
      setThreadHarnessSession: () => Effect.void,
      setThreadModel: () => Effect.void,
      createTurn: () => Effect.void,
      getTurn: () => Effect.succeedNone,
      getFirstTurn: () => Effect.succeedNone,
      getLatestTurn: () => Effect.succeedNone,
      listTurns: () => Effect.succeed([]),
      getLatestUserTurn: () => Effect.succeedNone,
      startTurn: () => Effect.void,
      putActivitySnapshot: () => Effect.void,
      getActivity: () => Effect.succeedNone,
      completeTurn: () => Effect.void,
      interruptTurn: () => Effect.void,
      failTurn: () => Effect.void,
    }
    const friday: FridayContract = {
      openThread: () =>
        Effect.succeed({
          prompt: (turn) =>
            Effect.sync(() => {
              promptedTurns.push(turn)
            }).pipe(Effect.as({ turnId: turn.id, awaitTerminal: Effect.never })),
          steer: () => Effect.void,
          cancel: () => Effect.void,
          reload: () => Effect.succeed(harnessReloadSucceeded()),
          onEvent: () => Effect.void,
          drain: Effect.never,
        }),
      observeRuntime: () => Effect.succeed({ runtimePresent: false, activeTurns: 0 }),
    }
    const tasks = makeTasks({
      persistence,
      friday,
      models: makeTaskModels(() => [
        {
          name: decodeProfileName('primary'),
          description: 'General delegated work.',
          model: decodeModel({ provider: 'opencode-go', modelId: 'deepseek-v4-flash' }),
          thinkingLevel: 'max',
        },
      ]),
      fileSystem,
      randomUUID: Effect.succeed('root-user-task-id'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    })

    yield* tasks.start({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-root-user-parent'),
      task: taskText,
      workingDirectory: decodeWorkingDirectory(projectDirectory),
    })

    assert.lengthOf(promptedTurns, 1)
    assert.strictEqual(promptedTurns[0]?.input.content.text, taskText)
    for (const leaked of ['222222222222222222', '444444444444444444', 'U08987654']) {
      assert.notInclude(promptedTurns[0]?.input.content.text ?? '', leaked)
    }
    // Task list summaries carry the persisted Turn text unchanged.
    const listed = yield* tasks.list({ parentThreadId: parent.id, status: 'all' })
    assert.deepStrictEqual(listed, [])
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)
