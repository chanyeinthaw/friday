import { test, expect } from 'bun:test'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { Attachments, attachmentsLayer, objectKey, stagingKey } from './Attachments.ts'
import { AttachmentObjects } from './AttachmentObjects.ts'
import { sqliteStorage, sqliteMigrations } from './SqliteStorage.ts'
import { Storage } from './Storage.ts'
import { failure } from './errors.ts'

test('upload lifecycle retains used objects, cleans abandoned files, and retries failed deletion', async () => {
  const blobs = new Map<string, Uint8Array>()
  let failDelete = ''
  const database = SqliteClient.layer({ filename: ':memory:' })
  const storage = sqliteStorage.pipe(
    Layer.provide(sqliteMigrations.pipe(Layer.provide(database))),
    Layer.provide(database),
  )
  const objects = Layer.succeed(
    AttachmentObjects,
    AttachmentObjects.of({
      uploadUrl: (key) => Effect.succeed(`https://storage.test/${key}`),
      downloadUrl: (key) => Effect.succeed(`https://storage.test/${key}`),
      read: (key, size) =>
        Effect.gen(function* () {
          const data = blobs.get(key)
          if (!data || data.length !== size)
            return yield* failure('Missing or incorrect file size.')
          return data
        }),
      write: (key, data) =>
        Effect.sync(() => {
          blobs.set(key, data)
        }),
      remove: (key) =>
        Effect.gen(function* () {
          if (failDelete === key) {
            failDelete = ''
            return yield* failure('Temporary S3 failure')
          }
          blobs.delete(key)
        }),
    }),
  )
  const services = Layer.mergeAll(
    database,
    storage,
    attachmentsLayer.pipe(Layer.provide(storage), Layer.provide(objects)),
  )
  // Bun SQLite needs the Bun integration runner; Vitest runs in Node.
  // oxlint-disable-next-line effect-local/no-manual-effect-runtime-in-tests
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* Attachments
      const sql = yield* SqlClient.SqlClient
      const stored = yield* Storage
      const create = (name: string) =>
        Effect.gen(function* () {
          const prepared = yield* files.prepare('user', { name, mediaType: 'text/plain', size: 5 })
          blobs.set(stagingKey('user', prepared.attachment.id), new TextEncoder().encode('hello'))
          yield* files.complete('user', prepared.attachment.id)
          return prepared.attachment
        })
      const used = yield* create('used.txt')
      const abandoned = yield* create('abandoned.txt')
      const incomplete = yield* files.prepare('user', {
        name: 'incomplete.txt',
        mediaType: 'text/plain',
        size: 5,
      })
      blobs.set(stagingKey('user', incomplete.attachment.id), new TextEncoder().encode('hello'))
      expect((yield* Effect.result(files.resolve('another-user', [used.id])))._tag).toBe('Failure')
      expect((yield* Effect.result(files.resolve('user', [incomplete.attachment.id])))._tag).toBe(
        'Failure',
      )
      yield* files.markUsed('user', [used.id])
      // Reusing an upload URL changes staging only; completion never replaces finalized bytes.
      blobs.set(stagingKey('user', used.id), new TextEncoder().encode('other'))
      yield* files.complete('user', used.id)
      expect(new TextDecoder().decode(yield* files.read('user', used))).toBe('hello')
      yield* files.cleanup
      expect(yield* files.resolve('user', [abandoned.id])).toEqual([abandoned])
      yield* sql`UPDATE wednesday_attachments SET expires_at=unixepoch()-1`
      failDelete = objectKey('user', abandoned.id)
      yield* files.cleanup
      expect(blobs.has(objectKey('user', used.id))).toBe(true)
      expect(blobs.has(stagingKey('user', used.id))).toBe(false)
      expect(blobs.has(stagingKey('user', incomplete.attachment.id))).toBe(false)
      expect(yield* stored.attachment('user', incomplete.attachment.id)).toBeNull()
      expect((yield* Effect.result(files.resolve('user', [abandoned.id])))._tag).toBe('Failure')
      // A failed deletion keeps the tombstone, so the next pass can finish the job.
      expect(blobs.has(objectKey('user', abandoned.id))).toBe(true)
      yield* files.cleanup
      expect(blobs.has(objectKey('user', abandoned.id))).toBe(false)
      expect(yield* stored.attachments('user')).toEqual([used])
      expect(yield* stored.attachment('user', abandoned.id)).toBeNull()
    }).pipe(Effect.provide(services), Effect.scoped),
  )
})
