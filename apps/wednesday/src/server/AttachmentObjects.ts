import { Config, Context, Effect, Layer, Redacted } from 'effect'
import type { WednesdayError } from './errors.ts'
import { failure } from './errors.ts'
import type { Attachment } from '../shared/Attachments.ts'

/** S3-compatible bytes and signing; metadata and file ownership live in Storage. */
export class AttachmentObjects extends Context.Service<
  AttachmentObjects,
  {
    readonly uploadUrl: (key: string, mediaType: string) => Effect.Effect<string, WednesdayError>
    readonly downloadUrl: (key: string, file: Attachment) => Effect.Effect<string, WednesdayError>
    readonly read: (key: string, size: number) => Effect.Effect<Uint8Array, WednesdayError>
    readonly write: (
      key: string,
      data: Uint8Array,
      mediaType: string,
    ) => Effect.Effect<void, WednesdayError>
    readonly remove: (key: string) => Effect.Effect<void, WednesdayError>
  }
>()('@friday/AttachmentObjects') {}

export const attachmentObjectsLayer = Layer.effect(
  AttachmentObjects,
  Effect.gen(function* () {
    const endpoint = yield* Config.String('WEDNESDAY_S3_ENDPOINT')
    const bucket = yield* Config.String('WEDNESDAY_S3_BUCKET')
    const accessKeyId = yield* Config.Redacted('WEDNESDAY_S3_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.Redacted('WEDNESDAY_S3_SECRET_ACCESS_KEY')
    const region = yield* Config.String('WEDNESDAY_S3_REGION').pipe(Config.withDefault('auto'))
    const client = new Bun.S3Client({
      endpoint,
      bucket,
      region,
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
    })
    const remote = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: () => failure('Attachment storage is unavailable. Please try again.'),
      })
    return AttachmentObjects.of({
      uploadUrl: (key, type) =>
        Effect.sync(() => client.presign(key, { method: 'PUT', expiresIn: 600, type })),
      downloadUrl: (key, file) =>
        Effect.sync(() =>
          client.presign(key, {
            method: 'GET',
            expiresIn: 900,
            type: file.mediaType.startsWith('image/') ? file.mediaType : 'application/octet-stream',
            contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          }),
        ),
      read: Effect.fn('AttachmentObjects.read')(function* (key, size) {
        const stat = yield* remote(() => client.stat(key))
        if (stat.size !== size)
          return yield* failure('The uploaded file size does not match. Please attach it again.')
        // Slice bounds the download even if a still-valid PUT URL overwrites staging after HEAD.
        const bytes = new Uint8Array(
          yield* remote(() =>
            client
              .file(key)
              .slice(0, size + 1)
              .arrayBuffer(),
          ),
        )
        if (bytes.length !== size)
          return yield* failure('The uploaded file changed. Please attach it again.')
        return bytes
      }),
      write: (key, data, type) =>
        remote(() => client.write(key, data, { type })).pipe(Effect.asVoid),
      remove: (key) => remote(() => client.unlink(key)),
    })
  }),
)
