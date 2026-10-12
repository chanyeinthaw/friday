import { Context, Effect, Schema } from 'effect'
import { LogEntry, type LogEntryInput } from '@humanlayer/fold-core'
import { ChatMessage, Settings } from '../shared/protocol.ts'
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
/** Domain storage contract; SQL and migration syntax stay in the adapter. */
export class Storage extends Context.Service<
  Storage,
  {
    readonly settings: (userId: string) => Effect.Effect<StoredSettings | null, WednesdayError>
    readonly saveSettings: (
      userId: string,
      settings: StoredSettings,
    ) => Effect.Effect<void, WednesdayError>
    readonly messages: (
      userId: string,
      afterId?: number,
    ) => Effect.Effect<readonly ChatMessage[], WednesdayError>
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
