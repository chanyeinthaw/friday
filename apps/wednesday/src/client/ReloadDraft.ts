import { Effect, Option, Schema } from 'effect'
import { Attachment } from '../shared/Attachments.ts'
import { MessageReply } from '../shared/protocol.ts'

export const ReloadDraft = Schema.Struct({
  userId: Schema.NonEmptyString,
  revision: Schema.Int,
  savedAt: Schema.Number,
  draft: Schema.String,
  attachments: Schema.Array(Attachment),
  reply: Schema.NullOr(MessageReply),
})
export interface ReloadDraft extends Schema.Schema.Type<typeof ReloadDraft> {}
const encode = Schema.encodeSync(Schema.fromJsonString(ReloadDraft))
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ReloadDraft))
const key = (userId: string) => `friday:reload-draft:${userId}`

export const saveReloadDraft = (draft: ReloadDraft) =>
  Effect.try(() => sessionStorage.setItem(key(draft.userId), encode(draft)))

// Session storage isolates tabs; the user and conversation revision isolate restored drafts.
export const takeReloadDraft = (userId: string) =>
  Effect.try(() => {
    const stored = sessionStorage.getItem(key(userId))
    if (stored === null) return null
    sessionStorage.removeItem(key(userId))
    return Option.getOrNull(decode(stored))
  }).pipe(Effect.catch(() => Effect.succeed(null)))

export const canRestoreDraft = (
  draft: ReloadDraft,
  userId: string,
  revision: number,
  now: number,
) =>
  draft.userId === userId &&
  draft.revision === revision &&
  now >= draft.savedAt &&
  now - draft.savedAt < 24 * 60 * 60 * 1000

export const canReload = (model: import('./App.ts').Model) =>
  model.connection === 'ready' &&
  !model.busy &&
  !model.uploading &&
  !model.saving &&
  !model.pendingMessages.some(
    (message) => message.status === 'sending' || message.status === 'waiting',
  )
