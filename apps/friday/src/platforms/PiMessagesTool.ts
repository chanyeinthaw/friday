/* oxlint-disable anti-slop/no-unknown-parameters -- Pi tool inputs cross an SDK boundary and are schema-decoded. */

import { PlatformMessageId, type ChannelThread } from '@friday/contracts/conversation'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformMessageQuery, PlatformMessageSearchResult } from './PlatformAdapter.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'

const MessagesToolInput = Schema.Struct({
  action: Schema.Literals(['fetch', 'search']),
  scope: Schema.Literals(['thread', 'channel']),
  query: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  ),
  before: Schema.optionalKey(PlatformMessageId),
  authorId: Schema.optionalKey(Schema.String),
})
const decodeInput = Schema.decodeUnknownEffect(MessagesToolInput)

const parameters = Type.Object({
  action: Type.Union([Type.Literal('fetch'), Type.Literal('search')]),
  scope: Type.Union([Type.Literal('thread'), Type.Literal('channel')]),
  query: Type.Optional(Type.String({ description: 'Case-insensitive text substring for search.' })),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 50, description: 'Maximum results. Defaults to 20.' }),
  ),
  before: Type.Optional(
    Type.String({ description: 'Fetch messages older than this platform message ID.' }),
  ),
  authorId: Type.Optional(
    Type.String({ description: 'Optional canonical platform user ID filter.' }),
  ),
})

const output = (result: PlatformMessageSearchResult) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  details: result,
})

export interface MakePiMessagesToolOptions {
  readonly thread: ChannelThread
  readonly platforms: Pick<PlatformRegistryContract, 'searchMessages'>
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

export const makePiMessagesTool = (options: MakePiMessagesToolOptions): ToolDefinition =>
  defineTool({
    name: 'messages',
    label: 'Messages',
    description: 'Fetch or search messages in the current thread or its parent channel.',
    promptSnippet: 'Use `messages` to recover older channel or thread conversation context.',
    parameters,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawInput) => {
      const input = await options.runPromise(decodeInput(rawInput))
      if (input.action === 'search' && (input.query === undefined || input.query.trim() === '')) {
        throw new Error('Search requires a non-empty query.')
      }
      const base: PlatformMessageQuery = {
        binding: options.thread.conversationBinding,
        scope: input.scope,
        limit: input.limit ?? 20,
      }
      const request: PlatformMessageQuery = {
        ...base,
        query: input.action === 'search' ? input.query : undefined,
        before: input.before,
        authorId: input.authorId,
      }
      return output(await options.runPromise(options.platforms.searchMessages(request)))
    },
  })
