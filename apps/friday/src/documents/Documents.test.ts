/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide, effecttsgo/process-env -- This suite exercises the real SQLite/filesystem boundary with isolated temporary directories. */

import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  contentPathFor,
  DocumentError,
  DocumentKey,
  DefaultDocumentConfig,
  Documents,
  isValidPublicBaseUrl,
  makeDocumentsLive,
} from './Documents.ts'
import { serveDocumentRequest } from './DocumentServer.ts'
import {
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from '../system-prompt/SystemPromptTemplates.ts'
import { ChannelThread } from '@friday/contracts/conversation'

const isDocumentError = Schema.is(DocumentError)
const isDocumentKey = Schema.is(DocumentKey)
const decodeKey = Schema.decodeSync(DocumentKey)
const decodeChannelThread = Schema.decodeSync(ChannelThread)

const SqlClientLive = SqliteClient.layer({ filename: ':memory:' })
const documentsLive = (directory: string) =>
  makeDocumentsLive({ documentsDirectory: directory }).pipe(
    Layer.provide(Layer.mergeAll(SqlClientLive, NodeFileSystem.layer, NodeCrypto.layer)),
  )
const freshDirectory = (prefix: string) => Effect.promise(() => mkdtemp(join(tmpdir(), prefix)))

/** Runs one program against a fresh database and documents directory. */
const withDocuments = <A, E>(program: Effect.Effect<A, E, Documents>) =>
  Effect.gen(function* () {
    const directory = yield* freshDirectory('friday-documents-test-')
    return yield* program.pipe(Effect.provide(documentsLive(directory)))
  })

const authOf = (url: string): string => new URL(url).searchParams.get('auth') ?? ''

describe('document keys', () => {
  it('accepts descriptive caller-selected keys', () => {
    for (const key of ['a', 'weekly-report', 'api_notes', 'Report2026', 'x'.repeat(128)]) {
      assert.isTrue(isDocumentKey(key), `expected '${key.slice(0, 20)}' to validate`)
    }
  })

  it('rejects traversal and unsafe keys', () => {
    for (const key of [
      '',
      '../evil',
      'a/b',
      '.hidden',
      '-lead',
      '_lead',
      'has space',
      'semi;colon',
      'x'.repeat(129),
    ]) {
      assert.isFalse(isDocumentKey(key), `expected '${key.slice(0, 20)}' to reject`)
    }
  })

  it('keeps resolved content paths inside the documents directory', () => {
    assert.strictEqual(
      contentPathFor('/tmp/friday-docs', decodeKey('weekly-report')),
      '/tmp/friday-docs/weekly-report',
    )
    assert.throws(() =>
      contentPathFor(
        '/tmp/friday-docs',
        // SAFETY: traversal rejection is exactly what this assertion exercises.
        '../evil' as DocumentKey,
      ),
    )
  })

  it('validates public base URLs without parsing exceptions', () => {
    assert.isTrue(isValidPublicBaseUrl('http://127.0.0.1:4020'))
    assert.isTrue(isValidPublicBaseUrl('https://docs.example.com/friday/'))
    assert.isFalse(isValidPublicBaseUrl(''))
    assert.isFalse(isValidPublicBaseUrl('ftp://example.com'))
    assert.isFalse(isValidPublicBaseUrl('https://user@example.com'))
    assert.isFalse(isValidPublicBaseUrl('https://example.com/search?q=1'))
    assert.isFalse(isValidPublicBaseUrl('not a url'))
  })
})

describe('document lifecycle', () => {
  it.effect('saves, reads, lists, and recovers URLs end to end', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const key = decodeKey('weekly-report')
        const saved = yield* documents.save(key, 'markdown', '# Weekly\n\nShipped.')
        assert.match(saved.url, /^http:\/\/127\.0\.0\.1:4020\/files\/weekly-report\?auth=/)
        assert.strictEqual(saved.metadata.key, 'weekly-report')
        assert.strictEqual(saved.metadata.format, 'markdown')

        const stored = yield* documents.get(key)
        assert.isTrue(Option.isSome(stored))
        if (Option.isSome(stored)) {
          assert.strictEqual(stored.value.content, '# Weekly\n\nShipped.')
          assert.strictEqual(stored.value.metadata.sizeBytes, saved.metadata.sizeBytes)
        }

        const listed = yield* documents.list()
        assert.strictEqual(listed.length, 1)
        assert.strictEqual(listed[0]?.key, 'weekly-report')
        // Metadata never carries the token-bearing URL.
        assert.notInclude(JSON.stringify(listed), authOf(saved.url))

        const recovered = yield* documents.url(key)
        assert.deepStrictEqual(recovered, Option.some(saved.url))

        const missing = yield* documents.url(decodeKey('absent'))
        assert.isTrue(Option.isNone(missing))
      }),
    ),
  )

  it.effect('preserves the URL across same-key overwrites', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const key = decodeKey('notes')
        const first = yield* documents.save(key, 'markdown', 'version one')
        const second = yield* documents.save(key, 'markdown', 'version two')
        assert.strictEqual(second.url, first.url)
        const stored = yield* documents.get(key)
        assert.isTrue(Option.isSome(stored))
        if (Option.isSome(stored)) assert.strictEqual(stored.value.content, 'version two')
      }),
    ),
  )

  it.effect('revokes the old URL and removes the document', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const key = decodeKey('secret')
        const saved = yield* documents.save(key, 'html', '<p>Secret</p>')
        const revoked = yield* documents.revoke(key)
        assert.isTrue(Option.isSome(revoked))
        if (Option.isNone(revoked)) return
        assert.notStrictEqual(revoked.value.url, saved.url)

        assert.isTrue(Option.isNone(yield* documents.verify('secret', authOf(saved.url))))
        const current = yield* documents.verify('secret', authOf(revoked.value.url))
        assert.isTrue(Option.isSome(current))

        assert.strictEqual(yield* documents.remove(key), 'removed')
        assert.strictEqual(yield* documents.remove(key), 'missing')
        assert.isTrue(Option.isNone(yield* documents.verify('secret', authOf(revoked.value.url))))
        assert.isTrue(Option.isNone(yield* documents.url(key)))
      }),
    ),
  )

  it.effect('keeps missing, wrong, and absent credentials indistinguishable', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const key = decodeKey('private')
        const saved = yield* documents.save(key, 'markdown', 'private content')
        const valid = authOf(saved.url)
        assert.isTrue(Option.isSome(yield* documents.verify('private', valid)))
        assert.isTrue(Option.isNone(yield* documents.verify('private', `${valid}x`)))
        assert.isTrue(Option.isNone(yield* documents.verify('private', null)))
        assert.isTrue(Option.isNone(yield* documents.verify('private', '')))
        assert.isTrue(Option.isNone(yield* documents.verify('absent', valid)))
        assert.isTrue(Option.isNone(yield* documents.verify('../evil', valid)))
        assert.isTrue(Option.isNone(yield* documents.verify('private', 'short')))
      }),
    ),
  )

  it.effect('preserves previous content when a save fails', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const key = decodeKey('durable')
        yield* documents.save(key, 'markdown', 'original content')
        const oversized = yield* documents
          .save(key, 'markdown', `x${'y'.repeat(DefaultDocumentConfig.maxBytes)}`)
          .pipe(Effect.flip)
        assert(isDocumentError(oversized))
        assert.strictEqual(oversized.operation, 'save')
        const stored = yield* documents.get(key)
        assert.isTrue(Option.isSome(stored))
        if (Option.isSome(stored)) assert.strictEqual(stored.value.content, 'original content')

        const empty = yield* documents.save(key, 'markdown', '   ').pipe(Effect.flip)
        assert(isDocumentError(empty))
        const preserved = yield* documents.get(key)
        assert.isTrue(Option.isSome(preserved))
        if (Option.isSome(preserved))
          assert.strictEqual(preserved.value.content, 'original content')
      }),
    ),
  )

  it.effect('reads serving configuration with conservative defaults', () =>
    withDocuments(
      Effect.gen(function* () {
        const documents = yield* Documents
        const config = yield* documents.getConfig()
        assert.deepStrictEqual(config, DefaultDocumentConfig)
        assert.strictEqual(config.listenHost, '127.0.0.1')
        assert.isTrue(config.maxBytes <= 5242880)
        const updated = yield* documents.updateConfig({
          publicBaseUrl: 'https://documents.example.com/',
          listenHost: '0.0.0.0',
        })
        assert.deepStrictEqual(updated, {
          ...DefaultDocumentConfig,
          publicBaseUrl: 'https://documents.example.com',
          listenHost: '0.0.0.0',
        })
        assert.deepStrictEqual(yield* documents.getConfig(), updated)
      }),
    ),
  )
})

describe('document HTTP behavior', () => {
  it.effect('serves valid URLs and returns one identical 404 otherwise', () =>
    Effect.gen(function* () {
      const directory = yield* freshDirectory('friday-documents-http-')
      const program = Effect.gen(function* () {
        const documents = yield* Documents
        const saved = yield* documents.save(decodeKey('report'), 'markdown', '# Report')
        const ok = yield* serveDocumentRequest('GET', saved.url)
        assert.strictEqual(ok.status, 200)
        assert.strictEqual(ok.headers['content-type'], 'text/html; charset=utf-8')
        assert.strictEqual(ok.headers['cache-control'], 'private, no-store')
        assert.strictEqual(ok.headers['referrer-policy'], 'no-referrer')
        assert.strictEqual(ok.headers['x-content-type-options'], 'nosniff')
        assert.strictEqual(ok.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
        assert.match(ok.headers['content-security-policy'] ?? '', /script-src 'none'/)
        assert.include(ok.body, '<h1>Report</h1>')
        assert.notInclude(ok.body, '<script')

        const valid = authOf(saved.url)
        const failures = yield* Effect.all([
          serveDocumentRequest('GET', 'http://127.0.0.1:4020/files/absent?auth=anything'),
          serveDocumentRequest('GET', `http://127.0.0.1:4020/files/report?auth=${valid}x`),
          serveDocumentRequest('GET', 'http://127.0.0.1:4020/files/report'),
          serveDocumentRequest('GET', 'http://127.0.0.1:4020/files/report?auth='),
          serveDocumentRequest('POST', saved.url),
          serveDocumentRequest('GET', 'http://127.0.0.1:4020/files/../evil?auth=x'),
          serveDocumentRequest('GET', 'http://127.0.0.1:4020/index'),
          serveDocumentRequest('GET', 'not a url'),
        ])
        for (const failure of failures) {
          assert.deepStrictEqual(failure, failures[0])
          assert.strictEqual(failure.status, 404)
          assert.strictEqual(failure.body, 'Not found\n')
          assert.notInclude(JSON.stringify(failure), valid)
        }
        return undefined
      })
      yield* program.pipe(Effect.provide(documentsLive(directory)))
    }),
  )
})

describe('document prompt', () => {
  const thread = decodeChannelThread({
    id: 'thread-documents',
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory: '/tmp/friday/channel-thread',
    model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'max',
    channelContext: { name: 'docs', description: '' },
    conversationBinding: {
      platform: 'discord',
      connectionId: 'discord',
      channelId: 'channel-documents',
      sourceMessageId: 'message-documents',
      conversationId: 'conversation-documents',
    },
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

  it.effect('grants the document capability in channel prompts only', () =>
    Effect.gen(function* () {
      const templates = yield* SystemPromptTemplates
      const prompt = yield* templates.renderChannelAgent({ thread, availableAgentModels: [] })
      assert.include(prompt, 'friday-document')
      assert.include(prompt, 'document save')
      assert.include(prompt, 'document revoke')
      assert.include(prompt, 'readability')
      const bootstrap = yield* templates.renderBootstrapAgent('/tmp/friday/bootstrap')
      assert.notInclude(bootstrap, 'friday-document')
    }).pipe(Effect.provide(SystemPromptTemplatesLive)),
  )
})
