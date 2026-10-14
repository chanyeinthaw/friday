import { Base64 } from 'effect/encoding'
import { Context, Effect, Layer, PartitionedSemaphore, Schedule } from 'effect'
import { Storage } from './Storage.ts'
import { AttachmentObjects } from './AttachmentObjects.ts'
import type { WednesdayError } from './errors.ts'
import {
  type AttachmentUpload,
  type Attachment,
  type AttachmentDownload,
  maxAttachmentSize,
} from '../shared/Attachments.ts'
import { failure } from './errors.ts'

/** File names are display names and single path components, never user-provided paths. */
export const attachmentPath = (file: { id: string; name: string }) =>
  `/attachments/${file.id}/${file.name}`

const attachmentName = (name: string) =>
  name
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/\p{Cc}/gu, '')
    .trim()
const detectMediaType = (name: string, bytes: Uint8Array) => {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end))
  return starts(137, 80, 78, 71, 13, 10, 26, 10)
    ? 'image/png'
    : starts(255, 216, 255)
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
        ? 'image/gif'
        : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
          ? 'image/webp'
          : /\.(md|markdown)$/i.test(name)
            ? 'text/markdown'
            : /\.(html?|xhtml)$/i.test(name)
              ? 'text/html'
              : /\.txt$/i.test(name)
                ? 'text/plain'
                : null
}

export const validateAttachment = Effect.fn('Attachments.validate')(function* (input: {
  name: string
  mediaType: string
  data: string
}) {
  const name = attachmentName(input.name)
  if (!name || name === '.' || name === '..')
    return yield* failure('Choose a file with a valid name.')
  const bytes = yield* Effect.fromResult(Base64.decode(input.data)).pipe(
    Effect.mapError(() => failure('The file could not be read.')),
  )
  if (!bytes.length || bytes.length > maxAttachmentSize || Base64.encode(bytes) !== input.data)
    return yield* failure('Choose a nonempty file smaller than 10 MB.')
  const mediaType = detectMediaType(name, bytes)
  if (!mediaType || (input.mediaType.startsWith('image/') && !mediaType.startsWith('image/')))
    return yield* failure('Choose a PNG, JPEG, GIF, WebP, text, Markdown, or HTML file.')
  if (
    mediaType.startsWith('text/') &&
    (bytes.includes(0) || new TextDecoder().decode(bytes).includes('\ufffd'))
  )
    return yield* failure('Text files must use UTF-8 encoding.')
  return {
    id: crypto.randomUUID(),
    name,
    mediaType,
    size: bytes.length,
    data: input.data,
  }
})

export const stagingKey = (userId: string, id: string) =>
  `uploads/${encodeURIComponent(userId)}/${id}`
export const objectKey = (userId: string, id: string) => `files/${encodeURIComponent(userId)}/${id}`

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly prepare: (
      userId: string,
      input: AttachmentUpload,
    ) => Effect.Effect<{ attachment: Attachment; url: string }, WednesdayError>
    readonly complete: (userId: string, id: string) => Effect.Effect<Attachment, WednesdayError>
    readonly resolve: (
      userId: string,
      ids: readonly string[],
    ) => Effect.Effect<readonly Attachment[], WednesdayError>
    readonly download: (
      userId: string,
      id: string,
    ) => Effect.Effect<AttachmentDownload, WednesdayError>
    readonly read: (userId: string, file: Attachment) => Effect.Effect<Uint8Array, WednesdayError>
    /** Used by message consumption and future durable filesystem saves. */
    readonly markUsed: (
      userId: string,
      ids: readonly string[],
    ) => Effect.Effect<void, WednesdayError>
    readonly cleanup: Effect.Effect<void, WednesdayError>
  }
>()('@friday/Attachments') {}

export const attachmentsLayer = Layer.effect(
  Attachments,
  Effect.gen(function* () {
    const storage = yield* Storage
    const objects = yield* AttachmentObjects
    const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 })
    const resolve = Effect.fn('Attachments.resolve')(function* (
      userId: string,
      ids: readonly string[],
    ) {
      return yield* Effect.forEach([...new Set(ids)], (id) =>
        Effect.gen(function* () {
          const file = yield* storage.attachment(userId, id)
          if (!file || (file.state !== 'ready' && file.state !== 'used'))
            return yield* failure('An attachment is no longer available. Please attach it again.')
          const { state: _state, ...metadata } = file
          return metadata
        }),
      )
    })
    const read = (userId: string, file: Attachment) =>
      objects.read(objectKey(userId, file.id), file.size)
    const cleanup = Effect.gen(function* () {
      const expired = yield* storage.claimExpiredAttachments()
      yield* Effect.forEach(
        expired,
        (file) =>
          locks
            .withPermit(`${file.userId}:${file.id}`)(
              Effect.gen(function* () {
                yield* objects.remove(stagingKey(file.userId, file.id))
                if (file.state === 'deleting')
                  yield* objects.remove(objectKey(file.userId, file.id))
                yield* storage.finishAttachmentCleanup(file.userId, file.id)
              }),
            )
            .pipe(
              Effect.catch(() =>
                Effect.logWarning('Attachment cleanup will retry an expired upload.'),
              ),
            ),
        { concurrency: 4, discard: true },
      )
    })
    yield* cleanup.pipe(
      Effect.catch(() => Effect.logWarning('Attachment cleanup will retry.')),
      Effect.repeat(Schedule.spaced('15 minutes')),
      Effect.forkScoped,
    )
    return Attachments.of({
      prepare: Effect.fn('Attachments.prepare')(function* (userId, input) {
        const name = attachmentName(input.name)
        if (!name || name === '.' || name === '..')
          return yield* failure('Choose a file with a valid name.')
        const mediaType = /\.(md|markdown)$/i.test(name)
          ? 'text/markdown'
          : /\.(html?|xhtml)$/i.test(name)
            ? 'text/html'
            : /\.txt$/i.test(name)
              ? 'text/plain'
              : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(input.mediaType)
                ? input.mediaType
                : null
        if (!mediaType)
          return yield* failure('Choose a PNG, JPEG, GIF, WebP, text, Markdown, or HTML file.')
        const attachment = { id: crypto.randomUUID(), name, mediaType, size: input.size }
        yield* storage.saveAttachment(userId, attachment)
        return {
          attachment,
          url: yield* objects.uploadUrl(stagingKey(userId, attachment.id), mediaType),
        }
      }),
      complete: Effect.fn('Attachments.complete')((userId, id) =>
        locks.withPermit(`${userId}:${id}`)(
          Effect.gen(function* () {
            const file = yield* storage.attachment(userId, id)
            if (!file)
              return yield* failure('This upload has expired. Please attach the file again.')
            if (file.state === 'ready' || file.state === 'used') {
              const { state: _state, ...metadata } = file
              return metadata
            }
            const bytes = yield* objects.read(stagingKey(userId, id), file.size)
            const validated = yield* validateAttachment({
              name: file.name,
              mediaType: file.mediaType,
              data: Base64.encode(bytes),
            })
            if (validated.mediaType !== file.mediaType)
              return yield* failure('The file contents do not match its type.')
            // Never issue PUT URLs for finalized objects; replaying an upload URL cannot alter a sent file.
            yield* objects.write(objectKey(userId, id), bytes, file.mediaType)
            yield* storage.completeAttachment(userId, id)
            yield* objects
              .remove(stagingKey(userId, id))
              .pipe(Effect.catch(() => Effect.logWarning('Attachment staging cleanup will retry.')))
            const { state: _state, ...metadata } = file
            return metadata
          }),
        ),
      ),
      resolve,
      read,
      download: Effect.fn('Attachments.download')(function* (userId, id) {
        const files = yield* resolve(userId, [id])
        const attachment = files[0]
        if (!attachment) return yield* failure('This attachment is no longer available.')
        return { attachment, url: yield* objects.downloadUrl(objectKey(userId, id), attachment) }
      }),
      markUsed: storage.commitAttachments,
      cleanup,
    })
  }),
)
