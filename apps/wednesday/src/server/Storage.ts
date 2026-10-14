import { Attachment } from '../shared/Attachments.ts'
import { Context, Effect, Schema } from 'effect'
import { LogEntry, type LogEntryInput } from '@humanlayer/fold-core'
import { ChatMessage, Settings, PendingMessage } from '../shared/protocol.ts'
import type { WednesdayError } from './errors.ts'

export const StoredSettings = Schema.Struct({ settings: Settings, encryptedKey: Schema.String })
export interface StoredSettings extends Schema.Schema.Type<typeof StoredSettings> {}
export const Part = Schema.Struct({ id: Schema.Int, count: Schema.Int })
export const Node = Schema.Struct({ ...Part.fields, text: Schema.String })
export const MemoryState = Schema.Struct({
  parts: Schema.Array(Part),
  pending: Schema.Boolean,
  revision: Schema.Int,
  compactParts: Schema.Array(Part),
  compactPending: Schema.Boolean,
  compactRevision: Schema.Int,
  total: Schema.Int,
  frontier: Schema.Int,
})
export interface MemoryState extends Schema.Schema.Type<typeof MemoryState> {}
export const MemoryJob = Schema.Struct({ ...Part.fields, source: Schema.String })
export interface MemoryJob extends Schema.Schema.Type<typeof MemoryJob> {}
export const StoredAttachment = Schema.Struct({
  ...Attachment.fields,
  state: Schema.Literals(['pending', 'ready', 'used', 'deleting']),
})
export interface StoredAttachment extends Schema.Schema.Type<typeof StoredAttachment> {}
export interface ExpiredAttachment {
  readonly userId: string
  readonly id: string
  readonly state: StoredAttachment['state']
}
/** Domain storage contract; SQL and migration syntax stay in the adapter. */
export class Storage extends Context.Service<
  Storage,
  {
    readonly clearConversation: (userId: string) => Effect.Effect<void, WednesdayError>
    readonly conversationRevision: (userId: string) => Effect.Effect<number, WednesdayError>
    readonly saveAttachment: (
      userId: string,
      file: Attachment,
    ) => Effect.Effect<void, WednesdayError>
    readonly attachment: (
      userId: string,
      id: string,
    ) => Effect.Effect<StoredAttachment | null, WednesdayError>
    readonly attachments: (userId: string) => Effect.Effect<readonly Attachment[], WednesdayError>
    readonly commitAttachments: (
      userId: string,
      ids: readonly string[],
    ) => Effect.Effect<void, WednesdayError>
    readonly completeAttachment: (userId: string, id: string) => Effect.Effect<void, WednesdayError>
    readonly claimExpiredAttachments: () => Effect.Effect<
      readonly ExpiredAttachment[],
      WednesdayError
    >
    readonly finishAttachmentCleanup: (
      userId: string,
      id: string,
    ) => Effect.Effect<void, WednesdayError>
    readonly integrationKey: (
      userId: string,
      integration: 'firecrawl',
    ) => Effect.Effect<string | null, WednesdayError>
    readonly saveIntegrationKey: (
      userId: string,
      integration: 'firecrawl',
      encryptedKey: string | null,
    ) => Effect.Effect<void, WednesdayError>
    readonly settleActivities: (
      userId: string,
    ) => Effect.Effect<readonly ChatMessage[], WednesdayError>
    readonly settings: (userId: string) => Effect.Effect<StoredSettings | null, WednesdayError>
    readonly saveSettings: (
      userId: string,
      settings: StoredSettings,
    ) => Effect.Effect<void, WednesdayError>
    readonly messages: (
      userId: string,
      afterId?: number,
    ) => Effect.Effect<readonly ChatMessage[], WednesdayError>
    readonly history: (
      userId: string,
      beforeId?: number,
    ) => Effect.Effect<
      { readonly messages: readonly ChatMessage[]; readonly hasOlder: boolean },
      WednesdayError
    >
    readonly memory: (userId: string) => Effect.Effect<MemoryState, WednesdayError>
    readonly saveMemory: (userId: string, state: MemoryState) => Effect.Effect<void, WednesdayError>
    readonly withMemory: <A, E, R>(
      userId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
    readonly memoryNodes: (
      userId: string,
      parts: readonly (typeof Part.Type)[],
    ) => Effect.Effect<readonly (typeof Node.Type)[], WednesdayError>
    readonly memoryJobs: (
      userId: string,
      capacity: number,
    ) => Effect.Effect<readonly MemoryJob[], WednesdayError>
    readonly completeMemoryJob: (
      userId: string,
      node: typeof Node.Type,
    ) => Effect.Effect<void, WednesdayError>
    readonly failMemoryJob: (
      userId: string,
      part: typeof Part.Type,
    ) => Effect.Effect<void, WednesdayError>
    readonly retryMemoryJobs: (userId: string) => Effect.Effect<void, WednesdayError>
    readonly message: (
      userId: string,
      id: number,
    ) => Effect.Effect<ChatMessage | null, WednesdayError>
    readonly logSequence: (userId: string) => Effect.Effect<number, WednesdayError>
    readonly logs: (
      userId: string,
      fromSeq?: number,
    ) => Effect.Effect<readonly LogEntry[], WednesdayError>
    readonly appendLog: (
      userId: string,
      entry: LogEntryInput,
      consumedRequestId: string | null,
      messageDate?: string,
      submission?: Pick<PendingMessage, 'text' | 'reply' | 'attachments'>,
    ) => Effect.Effect<{ entry: LogEntry; messages: readonly ChatMessage[] }, WednesdayError>
    readonly recover: () => Effect.Effect<void, WednesdayError>
  }
>()('@wednesday/Storage') {}

export class Migrations extends Context.Service<
  Migrations,
  {
    readonly run: () => Effect.Effect<void, WednesdayError>
  }
>()('@wednesday/Migrations') {}
