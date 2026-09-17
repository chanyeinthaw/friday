import * as Effect from 'effect/Effect'

import { AppConfig } from '../../config/AppConfigLive.ts'
import { ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { findDuplicateDiscordApplications } from './DiscordAgentActivity.ts'
import { makeDiscordConnectionRuntime } from './DiscordConnectionRuntime.ts'

export const startDiscord = Effect.fn('startDiscord')(function* () {
  const config = yield* AppConfig
  // Startup topology snapshot: Discord resources are built once per process.
  const startup = config.current()
  const connections = startup.platforms.discord
  if (connections.length === 0) {
    yield* Effect.logDebug('discord.disabled').pipe(Effect.annotateLogs({ component: 'discord' }))
    return []
  }
  const duplicateApplications = findDuplicateDiscordApplications(
    connections.map((connection) => ({
      connectionId: String(connection.connectionId),
      applicationId: String(connection.credentials.applicationId),
      botToken: String(connection.credentials.botToken),
    })),
  )
  if (duplicateApplications.length > 0) {
    return yield* new ChatSdkLifecycleError({
      operation: 'create-adapter',
      cause: new Error(
        `Duplicate Discord application connections: ${duplicateApplications
          .map((connectionIds) => connectionIds.join(', '))
          .join('; ')}`,
      ),
    })
  }

  // Admin access is pinned to the startup snapshot so reloads cannot lock out
  // the administrators who are allowed to perform them.
  return yield* Effect.forEach(
    connections,
    (connection) => makeDiscordConnectionRuntime(connection, startup.admin),
    { concurrency: 'unbounded' },
  )
})
