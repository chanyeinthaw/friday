import { ChannelThread, ThreadId } from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'

import { FRIDAY_HOME } from '../../FridayHome.ts'
import type { AppConfig } from '../../config/AppConfig.ts'
import type { PlatformInput } from '../PlatformAdapter.ts'
import type { SlackAdapter } from '@chat-adapter/slack'
import { decodeSlackConversationId, toSlackAdapterChannelId } from './SlackConversationScope.ts'

const decodeChannelThread = Schema.decodeUnknownSync(ChannelThread)
const decodeThreadId = Schema.decodeUnknownSync(ThreadId)

export class SlackThreadBootstrapError extends Schema.Error<SlackThreadBootstrapError>(
  'SlackThreadBootstrapError',
)({
  _tag: Schema.tag('SlackThreadBootstrapError'),
  operation: Schema.Literals(['channel-context', 'workspace']),
  cause: Schema.Defect(),
}) {}

export interface SlackThreadBootstrapAdapter extends Pick<SlackAdapter, 'fetchChannelInfo'> {}

export interface SlackThreadBootstrapOptions {
  readonly adapter: SlackThreadBootstrapAdapter
  readonly workingDirectoryRoot?: string
  /**
   * Reads the current primary model at thread-creation time so configuration
   * reloads apply to newly bootstrapped threads without a restart.
   */
  readonly model?: () => AppConfig['models']['primary']
}

const ChannelMetadata = Schema.Struct({
  purpose: Schema.optional(Schema.NullOr(Schema.String)),
  topic: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeChannelMetadata = Schema.decodeUnknownOption(ChannelMetadata)

const adapterChannelIdFrom = (binding: PlatformInput['binding']): string => {
  const location = decodeSlackConversationId(String(binding.conversationId))
  if (location !== undefined) return toSlackAdapterChannelId(location)
  const parts = String(binding.channelId).split(':')
  const channel = parts[parts.length - 1] ?? String(binding.channelId)
  return `slack:${channel}`
}

export const makeSlackThreadBootstrap = Effect.fn('makeSlackThreadBootstrap')(function* (
  options: SlackThreadBootstrapOptions,
) {
  const crypto = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem

  return Effect.fn('SlackThreadBootstrap.create')(function* (inbound: PlatformInput) {
    const channelId = adapterChannelIdFrom(inbound.binding)
    const channel = yield* Effect.tryPromise({
      try: () => options.adapter.fetchChannelInfo(channelId),
      catch: (cause) => new SlackThreadBootstrapError({ operation: 'channel-context', cause }),
    })
    const metadata = Option.getOrUndefined(decodeChannelMetadata(channel.metadata))
    // Channel-scoped workspaces: the working directory stays keyed by the
    // canonical conversation (team + channel [+ thread]), never the adapter id.
    const rawName = channel.name ?? String(inbound.binding.channelId)
    const channelName = rawName.startsWith('#') ? rawName.slice(1) : rawName
    const channelDescription = [metadata?.topic ?? '', metadata?.purpose ?? '']
      .map((part) => (part ?? '').trim())
      .filter((part) => part.length > 0)
      .join('\n')
    const workspaceName = String(inbound.binding.conversationId)
      .replaceAll(':', '-')
      .replaceAll('.', '-')
    const workingDirectory = join(
      options.workingDirectoryRoot ?? join(FRIDAY_HOME, 'workspaces'),
      workspaceName,
    )
    yield* fileSystem
      .makeDirectory(workingDirectory, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new SlackThreadBootstrapError({ operation: 'workspace', cause }),
        ),
      )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    // One coherent read: a reload between two reads could otherwise pair a
    // model from one snapshot with a thinking level from another.
    const model = options.model?.()
    return decodeChannelThread({
      id: decodeThreadId(yield* crypto.randomUUIDv4),
      audience: 'user',
      parent: null,
      harness: 'pi',
      harnessSession: null,
      workingDirectory,
      model: model ?? {
        provider: 'opencode-go',
        modelId: 'deepseek-v4-flash',
      },
      thinkingLevel: model?.thinkingLevel ?? 'max',
      channelContext: {
        name: channelName,
        description: channelDescription,
      },
      conversationBinding: inbound.binding,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    })
  })
})
