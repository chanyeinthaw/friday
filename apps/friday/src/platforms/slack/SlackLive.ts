import * as Effect from 'effect/Effect'

import { AppConfig } from '../../config/AppConfigLive.ts'
import { ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { makeSlackConnectionRuntime } from './SlackConnectionRuntime.ts'

/** Groups of connection ids sharing one Slack app token (never the token itself). */
const findDuplicateSlackApps = (
  connections: ReadonlyArray<{ readonly connectionId: string; readonly appToken: string }>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const byToken = new Map<string, Array<string>>()
  for (const connection of connections) {
    const existing = byToken.get(connection.appToken)
    if (existing === undefined) byToken.set(connection.appToken, [connection.connectionId])
    else existing.push(connection.connectionId)
  }
  return [...byToken.values()].filter((group) => group.length > 1)
}

export const startSlack = Effect.fn('startSlack')(function* () {
  const config = yield* AppConfig
  // Startup topology snapshot: Slack resources are built once per process.
  const connections = config.current().platforms.slack
  if (connections.length === 0) {
    yield* Effect.logDebug('slack.disabled').pipe(Effect.annotateLogs({ component: 'slack' }))
    return []
  }
  const socketConnections = connections.filter((connection) => connection.mode === 'socket')
  if (socketConnections.length < connections.length) {
    yield* Effect.logWarning('slack.webhook-skipped').pipe(
      Effect.annotateLogs({
        component: 'slack',
        skipped: connections.length - socketConnections.length,
        detail: 'Webhook transport is not implemented; only Socket Mode connections start.',
      }),
    )
  }
  if (socketConnections.length === 0) {
    yield* Effect.logDebug('slack.disabled').pipe(Effect.annotateLogs({ component: 'slack' }))
    return []
  }
  const duplicateApps = findDuplicateSlackApps(
    socketConnections.map((connection) => ({
      connectionId: String(connection.connectionId),
      appToken: String(connection.credentials.appToken),
    })),
  )
  if (duplicateApps.length > 0) {
    return yield* new ChatSdkLifecycleError({
      operation: 'create-adapter',
      cause: new Error(
        `Duplicate Slack application connections: ${duplicateApps
          .map((connectionIds) => connectionIds.join(', '))
          .join('; ')}`,
      ),
    })
  }

  return yield* Effect.forEach(socketConnections, makeSlackConnectionRuntime, {
    concurrency: 'unbounded',
  })
})
