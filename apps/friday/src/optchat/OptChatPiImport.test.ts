import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestConsole from 'effect/testing/TestConsole'

import { parseFridayCli, renderCliHelp, runFridayCli } from '../Cli.ts'
import { ControlSocketError } from '../control/ControlSocket.ts'
import { FridayCliError } from '../cli/Types.ts'
import {
  formatImportOutcome,
  isOptChatImportError,
  mapBranchToInputs,
  mapPiSessionContent,
  parsePiSessionFile,
  requireEnabledBinding,
  selectActiveBranch,
} from './OptChatPiImport.ts'

const isFridayCliError = Schema.is(FridayCliError)
const line = (value: unknown): string => JSON.stringify(value)
const session = (id: string, extra?: Record<string, unknown>): string =>
  line({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-10-01T00:00:00.000Z',
    cwd: '/work',
    ...extra,
  })
const messageEntry = (
  id: string,
  parentId: string | null,
  message: unknown,
  timestamp = '2026-10-01T00:01:00.000Z',
): string => line({ type: 'message', id, parentId, timestamp, message })
const userMessage = (text: unknown, timestamp = Date.parse('2026-10-05T00:00:00.000Z')) => ({
  role: 'user',
  content: text,
  timestamp,
})
const assistantMessage = (
  content: unknown,
  timestamp = Date.parse('2026-10-05T00:01:00.000Z'),
) => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'test',
  model: 'test-model',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp,
})
const toolResultMessage = (
  content: unknown,
  timestamp = Date.parse('2026-10-05T00:02:00.000Z'),
) => ({
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'read',
  content,
  isError: false,
  timestamp,
})

it.effect('parses the optchat import command with trailing flags', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'optchat', 'import', 'chan-main', '/tmp/session.jsonl']),
      {
        type: 'config-optchat-import',
        id: 'chan-main',
        path: '/tmp/session.jsonl',
        dryRun: false,
        json: false,
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'optchat',
        'import',
        'chan-main',
        '/tmp/s.jsonl',
        '--dry-run',
      ]),
      {
        type: 'config-optchat-import',
        id: 'chan-main',
        path: '/tmp/s.jsonl',
        dryRun: true,
        json: false,
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'optchat',
        'import',
        'chan-main',
        '/tmp/s.jsonl',
        '--json',
        '--dry-run',
      ]),
      {
        type: 'config-optchat-import',
        id: 'chan-main',
        path: '/tmp/s.jsonl',
        dryRun: true,
        json: true,
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl', '--json']),
      {
        type: 'config-optchat-import',
        id: 'chan-main',
        path: '/tmp/s.jsonl',
        dryRun: false,
        json: true,
      },
    )
  }),
)

it.effect('rejects malformed optchat import commands', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'optchat', 'import'],
      ['config', 'optchat', 'import', 'chan-main'],
      ['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl', '--branch', 'x'],
      ['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl', '--dry-run', '--dry-run'],
      ['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl', '--json', 'extra'],
      ['config', 'optchat', 'import', '--dry-run', '/tmp/s.jsonl'],
      ['config', 'optchat', 'import', 'chan-main', '--json'],
      ['config', 'optchat', 'import', '', '/tmp/s.jsonl'],
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected typed failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect('documents the import command in help', () =>
  Effect.gen(function* () {
    assert.match(renderCliHelp([]), /config optchat import <memory-id> <path>/)
    assert.match(renderCliHelp(['config', 'optchat']), /Import a Pi session JSONL transcript/)
  }),
)

it.effect('maps user, assistant, tool, and tool results while excluding reasoning', () =>
  Effect.gen(function* () {
    const content = [
      session('sess-1'),
      messageEntry('a1', null, userMessage('Hello world')),
      messageEntry(
        'a2',
        'a1',
        assistantMessage([
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'Hi there' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
        ]),
      ),
      messageEntry('a3', 'a2', toolResultMessage([{ type: 'text', text: 'file contents' }])),
      messageEntry('a4', 'a3', {
        role: 'system',
        content: 'skip me',
        timestamp: Date.parse('2026-10-05T00:03:00.000Z'),
      }),
      messageEntry(
        'a5',
        'a4',
        userMessage([
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ]),
      ),
    ].join('\n')
    const mapped = yield* mapPiSessionContent(content)
    assert.strictEqual(mapped.sessionId, 'sess-1')
    assert.deepStrictEqual(
      mapped.inputs.map((input) => [input.sourceKey, input.kind, input.text]),
      [
        ['pi-import:sess-1:a1:0', 'user', 'Hello world'],
        ['pi-import:sess-1:a2:0:1', 'talk', 'Hi there'],
        ['pi-import:sess-1:a2:0:2', 'tool', 'read {\"path\":\"a.txt\"}'],
        ['pi-import:sess-1:a3:0', 'echo', 'file contents'],
        ['pi-import:sess-1:a5:0', 'user', 'see this\n[image:image/png]'],
      ],
    )
    assert(
      mapped.inputs.every((input) => typeof input.date === 'string' && input.date.includes('2026')),
    )
  }),
)

it.effect('unwraps Friday prompt envelopes to the trigger text', () =>
  Effect.gen(function* () {
    const envelope = JSON.stringify({
      kind: 'user-message',
      participants: [],
      historicalContext: [],
      trigger: { kind: 'trigger', participantId: 'p1', content: 'trigger text' },
    })
    const content = [
      session('sess-envelope'),
      messageEntry('e1', null, userMessage(envelope)),
    ].join('\n')
    const mapped = yield* mapPiSessionContent(content)
    assert.strictEqual(mapped.inputs[0]?.text, 'trigger text')
  }),
)

it.effect('imports only the active leaf branch', () =>
  Effect.gen(function* () {
    const content = [
      session('sess-branch'),
      messageEntry('b1', null, userMessage('root')),
      messageEntry('b2', 'b1', userMessage('abandoned branch')),
      messageEntry('b3', 'b1', userMessage('active branch')),
    ].join('\n')
    const parsed = yield* parsePiSessionFile(content)
    const branch = selectActiveBranch(parsed.entries)
    assert.deepStrictEqual(
      branch.map((entry) => entry.id),
      ['b1', 'b3'],
    )
    const mapped = yield* mapPiSessionContent(content)
    assert.deepStrictEqual(
      mapped.inputs.map((input) => input.text),
      ['root', 'active branch'],
    )
  }),
)

it.effect('keeps original messages when a compaction entry sits on the branch', () =>
  Effect.gen(function* () {
    const content = [
      session('sess-compact'),
      messageEntry('c1', null, userMessage('original one')),
      messageEntry('c2', 'c1', userMessage('original two')),
      line({
        type: 'compaction',
        id: 'c3',
        parentId: 'c2',
        timestamp: '2026-10-01T00:02:00.000Z',
        summary: 'summary text',
        firstKeptEntryId: 'c2',
        tokensBefore: 10,
      }),
      messageEntry('c4', 'c3', userMessage('after compaction')),
    ].join('\n')
    const mapped = yield* mapPiSessionContent(content)
    assert.deepStrictEqual(
      mapped.inputs.map((input) => input.text),
      ['original one', 'original two', 'after compaction'],
    )
    assert(!mapped.inputs.some((input) => input.text.includes('summary text')))
  }),
)

it.effect('applies context edits and honors omissions', () =>
  Effect.gen(function* () {
    const content = [
      session('sess-edit'),
      messageEntry('d1', null, userMessage('before edit')),
      messageEntry('d2', 'd1', userMessage('omitted')),
      line({
        type: 'context_edit',
        id: 'd3',
        parentId: 'd2',
        timestamp: '2026-10-01T00:03:00.000Z',
        targetId: 'd1',
        replacement: { content: 'after edit' },
      }),
      line({
        type: 'context_edit',
        id: 'd4',
        parentId: 'd3',
        timestamp: '2026-10-01T00:04:00.000Z',
        targetId: 'd2',
        replacement: null,
      }),
    ].join('\n')
    const mapped = yield* mapPiSessionContent(content)
    assert.deepStrictEqual(
      mapped.inputs.map((input) => input.text),
      ['after edit'],
    )
  }),
)

it.effect('fails on invalid timestamps instead of fabricating dates', () =>
  Effect.gen(function* () {
    const badCases = [
      [
        session('sess-bad-ts'),
        messageEntry('t1', null, { role: 'user', content: 'hi', timestamp: 'not-a-number' }),
      ].join('\n'),
      [session('sess-missing-ts'), messageEntry('t1', null, { role: 'user', content: 'hi' })].join(
        '\n',
      ),
    ]
    for (const content of badCases) {
      const failure = yield* mapPiSessionContent(content).pipe(Effect.flip)
      assert(isOptChatImportError(failure))
      assert.match(failure.detail, /timestamp/)
    }
  }),
)

it.effect('rejects invalid session files before any mapping', () =>
  Effect.gen(function* () {
    const cases = [
      '',
      messageEntry('x1', null, userMessage('no header first')),
      [session('s1'), '{not json'].join('\n'),
      [session('s1'), session('s2')].join('\n'),
      [
        session('s1'),
        line({ type: 'message', id: '', parentId: null, timestamp: 'x', message: {} }),
      ].join('\n'),
    ]
    for (const content of cases) {
      const failure = yield* mapPiSessionContent(content).pipe(Effect.flip)
      assert(isOptChatImportError(failure), `expected failure for: ${content.slice(0, 60)}`)
    }
  }),
)

it.effect('produces stable source keys for the same session', () =>
  Effect.gen(function* () {
    const content = [
      session('sess-stable'),
      messageEntry('s1', null, userMessage('one')),
      messageEntry('s2', 's1', userMessage('two')),
    ].join('\n')
    const first = yield* mapBranchToInputs(
      'sess-stable',
      selectActiveBranch((yield* parsePiSessionFile(content)).entries),
    )
    const second = yield* mapBranchToInputs(
      'sess-stable',
      selectActiveBranch((yield* parsePiSessionFile(content)).entries),
    )
    assert.deepStrictEqual(
      first.map((input) => input.sourceKey),
      second.map((input) => input.sourceKey),
    )
  }),
)

it.effect('requires an existing enabled binding', () =>
  Effect.gen(function* () {
    yield* requireEnabledBinding([{ id: 'chan', enabled: 1 }], 'chan')
    const missing = yield* requireEnabledBinding([], 'chan').pipe(Effect.flip)
    assert(isOptChatImportError(missing))
    assert.match(missing.detail, /not bound/)
    const disabled = yield* requireEnabledBinding([{ id: 'chan', enabled: 0 }], 'chan').pipe(
      Effect.flip,
    )
    assert(isOptChatImportError(disabled))
    assert.match(disabled.detail, /disabled/)
  }),
)

it.effect('dispatches the import command through the CLI runner', () =>
  Effect.gen(function* () {
    const outcome = {
      memoryId: 'chan-main',
      sessionId: 'sess-1',
      total: 2,
      imported: 2,
      skipped: 0,
      dryRun: false,
    }
    const calls: Array<{ id: string; path: string; dryRun: boolean }> = []
    const notRunning = new ControlSocketError({
      operation: 'connect',
      path: '/tmp/friday.sock',
      detail: 'Could not connect.',
      cause: { code: 'ENOENT' },
    })
    const base = {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.fail(notRunning),
      listConfiguredModels: () => Effect.die('unreachable'),
      getConfiguredModel: () => Effect.die('unreachable'),
      setConfiguredModel: () => Effect.die('unreachable'),
      listSubagentProfiles: () => Effect.die('unreachable'),
      getSubagentProfile: () => Effect.die('unreachable'),
      addSubagentProfile: () => Effect.die('unreachable'),
      updateSubagentProfile: () => Effect.die('unreachable'),
      removeSubagentProfile: () => Effect.die('unreachable'),
      listPiModels: () => Effect.die('unreachable'),
      getPiModel: () => Effect.die('unreachable'),
      reloadPiModels: () => Effect.die('unreachable'),
      ensureWorktree: () => Effect.die('unreachable'),
      listWorktrees: () => Effect.die('unreachable'),
      readDocumentContent: () => Effect.die('unreachable'),
      saveDocument: () => Effect.die('unreachable'),
      getDocument: () => Effect.die('unreachable'),
      listDocuments: () => Effect.die('unreachable'),
      getDocumentUrl: () => Effect.die('unreachable'),
      revokeDocument: () => Effect.die('unreachable'),
      removeDocument: () => Effect.die('unreachable'),
      getDocumentConfig: () => Effect.die('unreachable'),
      updateDocumentConfig: () => Effect.die('unreachable'),
      applyWorkspaceCleanup: () => Effect.die('unreachable'),
      listWorkspaceCleanupProposals: () => Effect.die('unreachable'),
      addDiscordAdmin: () => Effect.die('unreachable'),
      removeDiscordAdmin: () => Effect.die('unreachable'),
      listDiscordAdmins: () => Effect.die('unreachable'),
      addRootUser: () => Effect.die('unreachable'),
      removeRootUser: () => Effect.die('unreachable'),
      listRootUsers: () => Effect.die('unreachable'),
      getIdentityText: () => Effect.die('unreachable'),
      setIdentityText: () => Effect.die('unreachable'),
      addDiscordConnection: () => Effect.die('unreachable'),
      updateDiscordConnection: () => Effect.die('unreachable'),
      removeDiscordConnection: () => Effect.die('unreachable'),
      enableDiscordConnection: () => Effect.die('unreachable'),
      disableDiscordConnection: () => Effect.die('unreachable'),
      getDiscordConnection: () => Effect.die('unreachable'),
      listDiscordConnections: () => Effect.die('unreachable'),
      listDiscordGuilds: () => Effect.die('unreachable'),
      enableDiscordGuild: () => Effect.die('unreachable'),
      disableDiscordGuild: () => Effect.die('unreachable'),
      removeDiscordGuild: () => Effect.die('unreachable'),
      setDiscordGuildInvocation: () => Effect.die('unreachable'),
      setDiscordGuildUsers: () => Effect.die('unreachable'),
      setDiscordGuildChannels: () => Effect.die('unreachable'),
      setDiscordGuildChannel: () => Effect.die('unreachable'),
      resetDiscordGuildChannel: () => Effect.die('unreachable'),
      addSlackConnection: () => Effect.die('unreachable'),
      updateSlackConnection: () => Effect.die('unreachable'),
      removeSlackConnection: () => Effect.die('unreachable'),
      enableSlackConnection: () => Effect.die('unreachable'),
      disableSlackConnection: () => Effect.die('unreachable'),
      getSlackConnection: () => Effect.die('unreachable'),
      listSlackConnections: () => Effect.die('unreachable'),
      setSlackAccess: () => Effect.die('unreachable'),
      setSlackChannel: () => Effect.die('unreachable'),
      resetSlackChannel: () => Effect.die('unreachable'),
    }
    yield* runFridayCli(['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl'], {
      ...base,
      importOptChatSession: (input) =>
        Effect.sync(() => {
          calls.push({ ...input })
          return outcome
        }),
    })
    assert.deepStrictEqual(calls, [{ id: 'chan-main', path: '/tmp/s.jsonl', dryRun: false }])
    assert.strictEqual((yield* TestConsole.logLines).at(-1), formatImportOutcome(outcome))

    yield* runFridayCli(['config', 'optchat', 'import', 'chan-main', '/tmp/s.jsonl', '--json'], {
      ...base,
      importOptChatSession: () => Effect.succeed(outcome),
    })
    assert.strictEqual((yield* TestConsole.logLines).at(-1), JSON.stringify(outcome))
  }).pipe(Effect.provide(TestConsole.layer)),
)
