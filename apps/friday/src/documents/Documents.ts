/* oxlint-disable anti-slop/no-unsafe-dictionary-type, effecttsgo/node-builtin-import -- SQL rows are decoded immediately through Effect Schema; timing-safe auth comparison uses Node crypto. */

import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { timingSafeEqual } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

import { FRIDAY_DOCUMENTS_DIRECTORY } from '../FridayHome.ts'
import { runMigrations } from '../persistence/Migrations.ts'

export const DocumentKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)),
  Schema.brand('DocumentKey'),
)
export type DocumentKey = typeof DocumentKey.Type

export const DocumentFormat = Schema.Literals(['markdown', 'html'])
export type DocumentFormat = typeof DocumentFormat.Type

export const DocumentMetadata = Schema.Struct({
  key: DocumentKey,
  format: DocumentFormat,
  sizeBytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type DocumentMetadata = typeof DocumentMetadata.Type

export const DocumentConfig = Schema.Struct({
  publicBaseUrl: Schema.String,
  listenHost: Schema.String,
  listenPort: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  maxBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1024, maximum: 5242880 }))),
})
export type DocumentConfig = typeof DocumentConfig.Type

export const DefaultDocumentConfig: DocumentConfig = {
  publicBaseUrl: 'http://127.0.0.1:4020',
  listenHost: '127.0.0.1',
  listenPort: 4020,
  maxBytes: 262144,
}

export class DocumentError extends Schema.Error<DocumentError>('DocumentError')({
  _tag: Schema.tag('DocumentError'),
  operation: Schema.Literals([
    'save',
    'get',
    'list',
    'url',
    'revoke',
    'remove',
    'verify',
    'config',
    'read-input',
    'migrate',
    'decode',
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail
  }
}

export interface SavedDocument {
  readonly metadata: DocumentMetadata
  readonly url: string
}

export interface StoredDocument {
  readonly metadata: DocumentMetadata
  readonly content: string
}

export interface DocumentsContract {
  readonly save: (
    key: DocumentKey,
    format: DocumentFormat,
    content: string,
  ) => Effect.Effect<SavedDocument, DocumentError>
  readonly get: (key: DocumentKey) => Effect.Effect<Option.Option<StoredDocument>, DocumentError>
  readonly list: () => Effect.Effect<ReadonlyArray<DocumentMetadata>, DocumentError>
  readonly url: (key: DocumentKey) => Effect.Effect<Option.Option<string>, DocumentError>
  readonly revoke: (key: DocumentKey) => Effect.Effect<Option.Option<SavedDocument>, DocumentError>
  readonly remove: (key: DocumentKey) => Effect.Effect<'removed' | 'missing', DocumentError>
  /**
   * Verifies raw HTTP-supplied credentials without distinguishing failures:
   * unknown keys, invalid keys, missing auth, and wrong auth all resolve to
   * `None`. Never includes the supplied auth in any error.
   */
  readonly verify: (
    key: string,
    auth: string | null,
  ) => Effect.Effect<Option.Option<StoredDocument>, DocumentError>
  readonly getConfig: () => Effect.Effect<DocumentConfig, DocumentError>
  readonly updateConfig: (
    patch: DocumentConfigPatch,
  ) => Effect.Effect<DocumentConfig, DocumentError>
}

export class Documents extends Context.Service<Documents, DocumentsContract>()(
  'friday/documents/Documents',
) {}

const decodeKey = Schema.decodeUnknownEffect(DocumentKey)
const decodeFormat = Schema.decodeUnknownEffect(DocumentFormat)
const decodeMetadata = Schema.decodeUnknownEffect(DocumentMetadata)
const decodeConfig = Schema.decodeUnknownEffect(DocumentConfig)
const isDocumentKey = Schema.is(DocumentKey)

const DocumentRow = Schema.Struct({
  key: Schema.String,
  format: Schema.String,
  access_key: Schema.String,
  size_bytes: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DocumentRow))

const ConfigRow = Schema.Struct({
  public_base_url: Schema.String,
  listen_host: Schema.String,
  listen_port: Schema.Number,
  max_bytes: Schema.Number,
})
const decodeConfigRows = Schema.decodeUnknownEffect(Schema.Array(ConfigRow))

const utf8Size = (content: string): number => new TextEncoder().encode(content).length

/** Caller-selected keys are safe path segments by construction; this re-checks containment. */
export const contentPathFor = (directory: string, key: DocumentKey): string => {
  const root = resolve(directory)
  const candidate = resolve(root, key)
  if (candidate !== resolve(root, '.') && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Document key '${key}' escapes the documents directory.`)
  }
  return candidate
}

const contentPath = (directory: string, key: string): string =>
  // SAFETY: HTTP-supplied keys are validated by `verify` before reaching here;
  // CLI keys are schema-decoded. `contentPathFor` re-checks containment.
  contentPathFor(directory, key as DocumentKey)

export const isValidPublicBaseUrl = (value: string): boolean => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0 || /[\s?#]/.test(trimmed)) return false
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false
  const authority = trimmed.replace(/^https?:\/\//i, '').split('/')[0] ?? ''
  // Userinfo (@) would embed credentials; fragments and queries are stripped
  // by normalization and never belong in a base URL.
  if (authority.length === 0 || authority.includes('@')) return false
  return true
}

export const normalizePublicBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '')

/** Builds the secret document URL; only save, url, and revoke ever return one. */
export const buildDocumentUrl = (baseUrl: string, key: DocumentKey, accessKey: string): string =>
  `${normalizePublicBaseUrl(baseUrl)}/files/${encodeURIComponent(key)}?auth=${encodeURIComponent(accessKey)}`

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes)
    return false
  }
  return timingSafeEqual(leftBytes, rightBytes)
}

export interface DocumentConfigPatch {
  readonly publicBaseUrl?: string
  readonly listenHost?: string
  readonly listenPort?: number
  readonly maxBytes?: number
}

export interface DocumentsLiveOptions {
  readonly documentsDirectory?: string
}

export const makeDocumentsLive = (options?: DocumentsLiveOptions) =>
  Layer.effect(
    Documents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const fileSystem = yield* FileSystem.FileSystem
      const crypto = yield* Crypto.Crypto
      const directory = options?.documentsDirectory ?? FRIDAY_DOCUMENTS_DIRECTORY

      const failure =
        (operation: DocumentError['operation']) =>
        (cause: unknown): DocumentError =>
          cause instanceof DocumentError
            ? cause
            : new DocumentError({
                operation,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              })

      yield* runMigrations().pipe(Effect.mapError(failure('migrate')))

      const getConfig = Effect.fn('Documents.getConfig')(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT public_base_url, listen_host, listen_port, max_bytes
          FROM document_config WHERE id = 1
        `.pipe(Effect.mapError(failure('config')))
        const decoded = yield* decodeConfigRows(rows).pipe(Effect.mapError(failure('decode')))
        const row = decoded[0]
        if (row === undefined) return { ...DefaultDocumentConfig }
        const candidate = {
          publicBaseUrl: row.public_base_url,
          listenHost: row.listen_host,
          listenPort: row.listen_port,
          maxBytes: row.max_bytes,
        }
        const config = yield* decodeConfig(candidate).pipe(Effect.mapError(failure('decode')))
        if (!isValidPublicBaseUrl(config.publicBaseUrl)) {
          return yield* new DocumentError({
            operation: 'config',
            detail: `Stored document public base URL '${config.publicBaseUrl}' is invalid.`,
          })
        }
        return config
      })

      const updateConfig = Effect.fn('Documents.updateConfig')(function* (
        patch: DocumentConfigPatch,
      ) {
        const current = yield* getConfig()
        const candidate = yield* decodeConfig({ ...current, ...patch }).pipe(
          Effect.mapError(failure('decode')),
        )
        if (!isValidPublicBaseUrl(candidate.publicBaseUrl)) {
          return yield* new DocumentError({
            operation: 'config',
            detail: `Document public base URL '${candidate.publicBaseUrl}' is invalid.`,
          })
        }
        const config = {
          ...candidate,
          publicBaseUrl: normalizePublicBaseUrl(candidate.publicBaseUrl),
        }
        yield* sql`
          UPDATE document_config SET
            public_base_url = ${config.publicBaseUrl},
            listen_host = ${config.listenHost},
            listen_port = ${config.listenPort},
            max_bytes = ${config.maxBytes},
            updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `.pipe(Effect.mapError(failure('config')))
        return config
      })

      const rowToMetadata = (row: typeof DocumentRow.Type) =>
        decodeMetadata({
          key: row.key,
          format: row.format,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }).pipe(Effect.mapError(failure('decode')))

      const readContentFile = (key: DocumentKey) =>
        Effect.gen(function* () {
          const target = contentPath(directory, key)
          // Canonicalize before reading so a symlinked entry can never serve
          // content from outside the documents directory.
          const canonical = yield* fileSystem.realPath(target).pipe(Effect.mapError(failure('get')))
          if (canonical !== target) {
            return yield* new DocumentError({
              operation: 'get',
              detail: `Document '${key}' is unavailable.`,
            })
          }
          return yield* fileSystem.readFileString(canonical).pipe(Effect.mapError(failure('get')))
        })

      const writeContentFile = Effect.fn('Documents.writeContentFile')(function* (
        key: DocumentKey,
        content: string,
      ) {
        yield* fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError(failure('save')))
        const target = contentPath(directory, key)
        const suffix = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failure('save')))
        const temp = join(directory, `.${key}.${suffix}.tmp`)
        yield* fileSystem.writeFileString(temp, content).pipe(
          Effect.mapError(failure('save')),
          Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)),
        )
        // Atomic replacement: readers observe the previous or the next
        // complete file, never a partial write. The target is untouched until
        // this rename, so a failed save preserves the previous content.
        yield* fileSystem.rename(temp, target).pipe(
          Effect.mapError(failure('save')),
          Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)),
        )
      })

      const newAccessKey = (operation: DocumentError['operation']) =>
        crypto
          .randomBytes(32)
          .pipe(Effect.map(Encoding.encodeBase64Url), Effect.mapError(failure(operation)))

      const save = Effect.fn('Documents.save')(function* (
        key: DocumentKey,
        format: DocumentFormat,
        content: string,
      ) {
        const config = yield* getConfig()
        const size = utf8Size(content)
        if (size > config.maxBytes) {
          return yield* new DocumentError({
            operation: 'save',
            detail: `Document '${key}' is ${size} bytes; the limit is ${config.maxBytes} bytes.`,
          })
        }
        if (size === 0 || content.trim().length === 0) {
          return yield* new DocumentError({
            operation: 'save',
            detail: `Document '${key}' is empty.`,
          })
        }
        const existing = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents WHERE key = ${key} LIMIT 1
        `.pipe(Effect.mapError(failure('save')))
        const existingRow = (yield* decodeRows(existing).pipe(
          Effect.mapError(failure('decode')),
        ))[0]
        // Overwrites preserve the persisted access key so the same-key retry
        // returns the same URL; only new documents mint one.
        const accessKey = existingRow?.access_key ?? (yield* newAccessKey('save'))
        const now = DateTime.formatIso(yield* DateTime.now)
        const createdAt = existingRow?.created_at ?? now
        yield* writeContentFile(key, content)
        yield* sql`
          INSERT INTO documents (key, format, access_key, size_bytes, created_at, updated_at)
          VALUES (${key}, ${format}, ${accessKey}, ${size}, ${createdAt}, ${now})
          ON CONFLICT (key) DO UPDATE SET
            format = excluded.format,
            size_bytes = excluded.size_bytes,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(failure('save')))
        const metadata = yield* decodeMetadata({
          key,
          format,
          sizeBytes: size,
          createdAt,
          updatedAt: now,
        }).pipe(Effect.mapError(failure('decode')))
        return { metadata, url: buildDocumentUrl(config.publicBaseUrl, key, accessKey) }
      })

      const get = Effect.fn('Documents.get')(function* (key: DocumentKey) {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents WHERE key = ${key} LIMIT 1
        `.pipe(Effect.mapError(failure('get')))
        const row = (yield* decodeRows(rows).pipe(Effect.mapError(failure('decode'))))[0]
        if (row === undefined) return Option.none<StoredDocument>()
        const format = yield* decodeFormat(row.format).pipe(Effect.mapError(failure('decode')))
        const metadata = yield* rowToMetadata(row)
        const content = yield* readContentFile(key)
        return Option.some({ metadata: { ...metadata, format }, content })
      })

      const list = Effect.fn('Documents.list')(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents ORDER BY key
        `.pipe(Effect.mapError(failure('list')))
        const decoded = yield* decodeRows(rows).pipe(Effect.mapError(failure('decode')))
        return yield* Effect.forEach(decoded, rowToMetadata)
      })

      const url = Effect.fn('Documents.url')(function* (key: DocumentKey) {
        const config = yield* getConfig()
        const rows = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents WHERE key = ${key} LIMIT 1
        `.pipe(Effect.mapError(failure('url')))
        const row = (yield* decodeRows(rows).pipe(Effect.mapError(failure('decode'))))[0]
        if (row === undefined) return Option.none<string>()
        return Option.some(buildDocumentUrl(config.publicBaseUrl, key, row.access_key))
      })

      const revoke = Effect.fn('Documents.revoke')(function* (key: DocumentKey) {
        const config = yield* getConfig()
        const rows = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents WHERE key = ${key} LIMIT 1
        `.pipe(Effect.mapError(failure('revoke')))
        const row = (yield* decodeRows(rows).pipe(Effect.mapError(failure('decode'))))[0]
        if (row === undefined) return Option.none<SavedDocument>()
        const accessKey = yield* newAccessKey('revoke')
        const now = DateTime.formatIso(yield* DateTime.now)
        yield* sql`
          UPDATE documents SET access_key = ${accessKey}, updated_at = ${now} WHERE key = ${key}
        `.pipe(Effect.mapError(failure('revoke')))
        const format = yield* decodeFormat(row.format).pipe(Effect.mapError(failure('decode')))
        const metadata = yield* decodeMetadata({
          key,
          format,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
          updatedAt: now,
        }).pipe(Effect.mapError(failure('decode')))
        return Option.some({
          metadata,
          url: buildDocumentUrl(config.publicBaseUrl, key, accessKey),
        })
      })

      const remove = Effect.fn('Documents.remove')(function* (key: DocumentKey) {
        const deleted = yield* sql<Record<string, unknown>>`
          DELETE FROM documents WHERE key = ${key} RETURNING key
        `.pipe(Effect.mapError(failure('remove')))
        if (deleted.length === 0) return 'missing' as const
        // Content is invalidated by the deleted row even if file cleanup fails.
        yield* fileSystem.remove(contentPath(directory, key), { force: true }).pipe(Effect.ignore)
        return 'removed' as const
      })

      const verify = Effect.fn('Documents.verify')(function* (key: string, auth: string | null) {
        if (!isDocumentKey(key)) {
          // Dummy comparison keeps invalid keys timing-indistinguishable.
          constantTimeEqual(auth ?? '', 'x'.repeat((auth ?? '').length))
          return Option.none<StoredDocument>()
        }
        const validKey = yield* decodeKey(key).pipe(Effect.mapError(failure('decode')))
        const rows = yield* sql<Record<string, unknown>>`
          SELECT * FROM documents WHERE key = ${validKey} LIMIT 1
        `.pipe(Effect.mapError(failure('verify')))
        const row = (yield* decodeRows(rows).pipe(Effect.mapError(failure('decode'))))[0]
        // The supplied auth never reaches logs or errors; every failure below
        // resolves to the same absent result the HTTP layer maps to 404.
        if (row === undefined) {
          constantTimeEqual(auth ?? '', '0'.repeat((auth ?? '').length))
          return Option.none<StoredDocument>()
        }
        if (auth === null || auth.length === 0 || !constantTimeEqual(auth, row.access_key)) {
          return Option.none<StoredDocument>()
        }
        const content = yield* readContentFile(validKey).pipe(
          Effect.mapError(failure('verify')),
          Effect.option,
        )
        if (Option.isNone(content)) return Option.none<StoredDocument>()
        const format = yield* decodeFormat(row.format).pipe(Effect.mapError(failure('decode')))
        const metadata = yield* rowToMetadata(row)
        return Option.some({ metadata: { ...metadata, format }, content: content.value })
      })

      return Documents.of({ save, get, list, url, revoke, remove, verify, getConfig, updateConfig })
    }),
  )

export const DocumentsLive = makeDocumentsLive()
