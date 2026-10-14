import { Context, Effect, Redacted, Scope } from 'effect'
import type { LogEntryInput, LogEntry } from '@humanlayer/fold-core'
import type { Settings, ModelMapping, Thinking } from '../shared/protocol.ts'
import type { WednesdayError } from './errors.ts'

export interface AgentConnection {
  readonly userId: string
  readonly purpose: 'chat' | 'memory'
  readonly settings: Settings
  readonly mapping: ModelMapping
  readonly thinking: Thinking
  readonly cacheKey: string
  readonly credential: Effect.Effect<
    { readonly apiKey: Redacted.Redacted<string>; readonly accountId?: string },
    WednesdayError
  >
}
export interface AgentImage {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}
export interface AgentSession {
  readonly send: (
    text: string,
    images?: readonly AgentImage[],
  ) => Effect.Effect<string, WednesdayError>
  /** Returns false when the active run has already ended; never starts a follow-up turn. */
  readonly steer: (
    text: string,
    images?: readonly AgentImage[],
  ) => Effect.Effect<boolean, WednesdayError>
}
export interface AgentOptions {
  readonly connection: AgentConnection
  readonly systemPrompt: string
  readonly view: string
  readonly memory: {
    readonly zoom: (id: number, count: number) => Effect.Effect<string, WednesdayError>
    readonly date: (id: number) => Effect.Effect<string, WednesdayError>
  }
  readonly webSearch?: ((query: string) => Effect.Effect<string, WednesdayError>) | undefined
  readonly bash?: (command: string) => Effect.Effect<string, WednesdayError>
  readonly beforeRequest: Effect.Effect<void, WednesdayError>
  readonly onText?: (part: { readonly id: string; readonly delta: string }) => Effect.Effect<void>
  // Preserve the existing log format so changing engines requires no history migration.
  readonly append?: (entry: LogEntryInput) => Effect.Effect<LogEntry, WednesdayError>
}
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly open: (
      options: AgentOptions,
    ) => Effect.Effect<AgentSession, WednesdayError, Scope.Scope>
  }
>()('@friday/AgentRuntime') {}
