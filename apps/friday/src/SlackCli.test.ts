import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { PlatformConnectionId } from '@friday/contracts/conversation'

import { parseFridayCli, parseSlackAccessPolicySpec } from './Cli.ts'
import { SlackChannelId, SlackTokenEnvName } from './config/SlackConnections.ts'

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeTokenEnv = Schema.decodeSync(SlackTokenEnvName)
const decodeChannelId = Schema.decodeSync(SlackChannelId)

const parseType = (arguments_: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const action = yield* parseFridayCli(arguments_)
    return action.type
  })

it.effect('parses Slack connection lifecycle commands', () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* parseType([
        'config',
        'slack',
        'connection',
        'add',
        'slack-personal',
        '--name',
        'Personal Slack',
        '--bot-token-env',
        'FRIDAY_SLACK_BOT_TOKEN',
        '--app-token-env',
        'FRIDAY_SLACK_APP_TOKEN',
      ]),
      'config-slack-connection-add',
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'connection',
        'add',
        'slack-personal',
        '--name',
        'Personal Slack',
        '--bot-token-env',
        'FRIDAY_SLACK_BOT_TOKEN',
        '--app-token-env',
        'FRIDAY_SLACK_APP_TOKEN',
        '--reply-in-channel',
      ]),
      {
        type: 'config-slack-connection-add',
        connectionId: decodeConnectionId('slack-personal'),
        name: 'Personal Slack',
        botTokenEnv: decodeTokenEnv('FRIDAY_SLACK_BOT_TOKEN'),
        appTokenEnv: decodeTokenEnv('FRIDAY_SLACK_APP_TOKEN'),
        defaultReplyMode: 'reply-in-channel',
      },
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'connection', 'remove', 'slack-personal', '--yes']),
      'config-slack-connection-remove',
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'connection', 'enable', 'slack-personal']),
      'config-slack-connection-enable',
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'connection', 'get', 'slack-personal', '--json']),
      'config-slack-connection-get',
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'connection', 'list']),
      'config-slack-connection-list',
    )
  }),
)

it.effect('parses Slack connection updates with reply-mode flags', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'connection',
        'update',
        'slack-personal',
        '--reply-in-channel',
      ]),
      {
        type: 'config-slack-connection-update',
        connectionId: decodeConnectionId('slack-personal'),
        defaultReplyMode: 'reply-in-channel',
      },
    )
  }),
)

it.effect('parses Slack access and channel commands', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'access',
        'set-users',
        'slack-personal',
        'allow=U1,U2',
      ]),
      {
        type: 'config-slack-access-set',
        connectionId: decodeConnectionId('slack-personal'),
        subject: 'users',
        policy: { mode: 'allow', ids: ['U1', 'U2'] },
      },
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'access', 'set-channels', 'slack-personal', 'all']),
      'config-slack-access-set',
    )
    assert.strictEqual(
      yield* parseType([
        'config',
        'slack',
        'access',
        'set-workspaces',
        'slack-personal',
        'deny=T9',
      ]),
      'config-slack-access-set',
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'channel',
        'set',
        'slack-personal',
        'C456',
        'reply-in-thread',
      ]),
      {
        type: 'config-slack-channel-set',
        connectionId: decodeConnectionId('slack-personal'),
        channelId: decodeChannelId('C456'),
        patch: { replyMode: 'reply-in-thread' },
      },
    )
    // Flag forms set either override without ambiguity; the bare positional
    // reply mode above keeps the original form working.
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'channel',
        'set',
        'slack-personal',
        'C456',
        '--invocation',
        'all-messages',
      ]),
      {
        type: 'config-slack-channel-set',
        connectionId: decodeConnectionId('slack-personal'),
        channelId: decodeChannelId('C456'),
        patch: { invocationMode: 'all-messages' },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'channel',
        'set',
        'slack-personal',
        'C456',
        '--reply-in-channel',
        '--invocation',
        'all-messages',
      ]),
      {
        type: 'config-slack-channel-set',
        connectionId: decodeConnectionId('slack-personal'),
        channelId: decodeChannelId('C456'),
        patch: { invocationMode: 'all-messages', replyMode: 'reply-in-channel' },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'slack',
        'channel',
        'set',
        'slack-personal',
        'C456',
        'reply-in-channel',
        '--invocation',
        'mention-only',
      ]),
      {
        type: 'config-slack-channel-set',
        connectionId: decodeConnectionId('slack-personal'),
        channelId: decodeChannelId('C456'),
        patch: { invocationMode: 'mention-only', replyMode: 'reply-in-channel' },
      },
    )
    assert.strictEqual(
      yield* parseType(['config', 'slack', 'channel', 'reset', 'slack-personal', 'C456']),
      'config-slack-channel-reset',
    )
  }),
)

it.effect('parses Slack access policies with opaque ids', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseSlackAccessPolicySpec('all'), { mode: 'all', ids: [] })
    assert.deepStrictEqual(yield* parseSlackAccessPolicySpec('deny=T1'), {
      mode: 'deny',
      ids: ['T1'],
    })
  }),
)
