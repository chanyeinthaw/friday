/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- CLI dispatch tests stub every operation and assert printed output through TestConsole. */

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as TestConsole from 'effect/testing/TestConsole'

import {
  FridayCliError,
  parseFridayCli,
  renderCliHelp,
  renderDocumentList,
  runFridayCli,
} from '../Cli.ts'
import { DocumentKey } from './Documents.ts'

const decodeKey = Schema.decodeSync(DocumentKey)
const decodeLine = Schema.decodeUnknownSync(Schema.String)
const isFridayCliError = Schema.is(FridayCliError)

/** Every operation dies loudly; dispatch tests override exactly the reached ones. */
const unreachable = (..._arguments: ReadonlyArray<unknown>): Effect.Effect<never> =>
  Effect.die('unreachable')

const documentStubs = {
  start: Effect.die('unreachable'),
  reloadConfig: Effect.die('unreachable'),
  listConfiguredModels: unreachable,
  getConfiguredModel: unreachable,
  setConfiguredModel: unreachable,
  listSubagentProfiles: unreachable,
  getSubagentProfile: unreachable,
  addSubagentProfile: unreachable,
  updateSubagentProfile: unreachable,
  removeSubagentProfile: unreachable,
  listPiModels: unreachable,
  getPiModel: unreachable,
  reloadPiModels: unreachable,
  addDiscordAdmin: unreachable,
  removeDiscordAdmin: unreachable,
  listDiscordAdmins: unreachable,
  addRootUser: unreachable,
  removeRootUser: unreachable,
  listRootUsers: unreachable,
  getIdentityText: unreachable,
  setIdentityText: unreachable,
  addDiscordConnection: unreachable,
  updateDiscordConnection: unreachable,
  removeDiscordConnection: unreachable,
  enableDiscordConnection: unreachable,
  disableDiscordConnection: unreachable,
  getDiscordConnection: unreachable,
  listDiscordConnections: unreachable,
  listDiscordGuilds: unreachable,
  enableDiscordGuild: unreachable,
  disableDiscordGuild: unreachable,
  removeDiscordGuild: unreachable,
  setDiscordGuildInvocation: unreachable,
  setDiscordGuildUsers: unreachable,
  setDiscordGuildChannels: unreachable,
  setDiscordGuildChannel: unreachable,
  resetDiscordGuildChannel: unreachable,
  ensureWorktree: unreachable,
  listWorktrees: unreachable,
  applyWorkspaceCleanup: unreachable,
  listWorkspaceCleanupProposals: unreachable,
  readDocumentContent: unreachable,
  saveDocument: unreachable,
  getDocument: unreachable,
  listDocuments: unreachable,
  getDocumentUrl: unreachable,
  revokeDocument: unreachable,
  removeDocument: unreachable,
}

const recorder = <O>(outcome: O) => {
  const calls: Array<ReadonlyArray<unknown>> = []
  return {
    calls,
    operation: (...arguments_: ReadonlyArray<unknown>): Effect.Effect<O, never> =>
      Effect.sync(() => {
        calls.push(arguments_)
        return outcome
      }),
  }
}

const lastLine = Effect.map(TestConsole.logLines, (lines) =>
  decodeLine(lines[lines.length - 1] ?? ''),
)

describe('document CLI parsing', () => {
  it.effect('parses save with stdin-first defaults', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* parseFridayCli(['document', 'save', 'weekly-report']), {
        type: 'document-save',
        key: decodeKey('weekly-report'),
        format: 'markdown',
        json: false,
      })
      assert.deepStrictEqual(
        yield* parseFridayCli([
          'document',
          'save',
          'api-notes',
          '--format',
          'html',
          '--file',
          '/tmp/notes.html',
          '--json',
        ]),
        {
          type: 'document-save',
          key: decodeKey('api-notes'),
          format: 'html',
          file: '/tmp/notes.html',
          json: true,
        },
      )
    }),
  )

  it.effect('parses get, list, url, revoke, and remove', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* parseFridayCli(['document', 'get', 'weekly-report']), {
        type: 'document-get',
        key: decodeKey('weekly-report'),
        json: false,
      })
      assert.deepStrictEqual(yield* parseFridayCli(['document', 'list', '--json']), {
        type: 'document-list',
        json: true,
      })
      assert.deepStrictEqual(yield* parseFridayCli(['document', 'url', 'weekly-report']), {
        type: 'document-url',
        key: decodeKey('weekly-report'),
        json: false,
      })
      assert.deepStrictEqual(
        yield* parseFridayCli(['document', 'revoke', 'weekly-report', '--json']),
        { type: 'document-revoke', key: decodeKey('weekly-report'), json: true },
      )
      assert.deepStrictEqual(
        yield* parseFridayCli(['document', 'remove', 'weekly-report', '--yes']),
        { type: 'document-remove', key: decodeKey('weekly-report'), yes: true },
      )
    }),
  )

  it.effect('rejects unsafe keys, formats, and unconfirmed removal', () =>
    Effect.gen(function* () {
      for (const args of [
        ['document', 'save', '../evil'],
        ['document', 'save', 'notes', '--format', 'pdf'],
        ['document', 'save'],
        ['document', 'get', 'a/b'],
        ['document', 'remove', 'notes'],
        ['document', 'revoke', 'notes', '--yes'],
      ]) {
        const error = yield* parseFridayCli(args).pipe(Effect.flip)
        assert(isFridayCliError(error), `expected a CLI error for: ${args.join(' ')}`)
      }
      const unknown = yield* parseFridayCli(['document', 'dance']).pipe(Effect.flip)
      assert.strictEqual(
        unknown.message,
        "Unknown 'friday document' subcommand 'dance'. Known subcommands: save, get, list, url, revoke, remove.",
      )
    }),
  )

  it('lists document commands in help', () => {
    assert.include(renderCliHelp([]), '  document save <key>')
    assert.include(renderCliHelp(['document', 'save']), 'friday document save <key>')
    assert.include(renderCliHelp(['document', 'remove']), 'friday document remove <key> --yes')
  })
})

describe('document CLI secrecy', () => {
  it.effect('returns the token-bearing URL only from save, url, and revoke', () =>
    Effect.gen(function* () {
      const token = 'token-marker-save-1'
      const url = `http://127.0.0.1:4020/files/notes?auth=${token}`
      const metadata = {
        key: decodeKey('notes'),
        format: 'markdown' as const,
        sizeBytes: 8,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const content = recorder('content from stdin')
      const save = recorder({ metadata, url })
      yield* runFridayCli(['document', 'save', 'notes', '--json'], {
        ...documentStubs,
        readDocumentContent: content.operation,
        saveDocument: save.operation,
      })
      assert.deepStrictEqual(save.calls, [['notes', 'markdown', 'content from stdin']])
      assert.include(yield* lastLine, token)

      const get = recorder(Option.some({ metadata, content: '# Notes' }))
      yield* runFridayCli(['document', 'get', 'notes', '--json'], {
        ...documentStubs,
        getDocument: get.operation,
      })
      const getLine = yield* lastLine
      assert.include(getLine, '# Notes')
      assert.notInclude(getLine, token)
      assert.notInclude(getLine, 'auth')

      const list = recorder([metadata])
      yield* runFridayCli(['document', 'list', '--json'], {
        ...documentStubs,
        listDocuments: list.operation,
      })
      const listLine = yield* lastLine
      assert.include(listLine, 'notes')
      assert.notInclude(listLine, token)
      assert.notInclude(listLine, 'auth')

      const urlOf = recorder(Option.some(url))
      yield* runFridayCli(['document', 'url', 'notes', '--json'], {
        ...documentStubs,
        getDocumentUrl: urlOf.operation,
      })
      assert.include(yield* lastLine, token)
    }),
  )

  it.effect('reads --file content and reports missing documents plainly', () =>
    Effect.gen(function* () {
      const content = recorder('file content')
      const save = recorder({
        metadata: {
          key: decodeKey('k'),
          format: 'html' as const,
          sizeBytes: 12,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        url: 'http://127.0.0.1:4020/files/k?auth=t',
      })
      yield* runFridayCli(['document', 'save', 'k', '--format', 'html', '--file', '/tmp/k.html'], {
        ...documentStubs,
        readDocumentContent: content.operation,
        saveDocument: save.operation,
      })
      assert.deepStrictEqual(content.calls, [['/tmp/k.html']])
      assert.deepStrictEqual(save.calls, [['k', 'html', 'file content']])

      const missing = recorder(Option.none())
      yield* runFridayCli(['document', 'get', 'absent'], {
        ...documentStubs,
        getDocument: missing.operation,
      })
      assert.strictEqual(yield* lastLine, "Document 'absent' was not found.")

      const remove = recorder('missing' as const)
      yield* runFridayCli(['document', 'remove', 'absent', '--yes'], {
        ...documentStubs,
        removeDocument: remove.operation,
      })
      assert.strictEqual(yield* lastLine, "Document 'absent' was not found.")
    }),
  )

  it('renders the human document list without URLs', () => {
    assert.strictEqual(renderDocumentList([]), 'No documents are published.')
    assert.strictEqual(
      renderDocumentList([
        {
          key: decodeKey('a'),
          format: 'markdown',
          sizeBytes: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      'Published documents:\n  a  markdown  10 bytes',
    )
  })
})
