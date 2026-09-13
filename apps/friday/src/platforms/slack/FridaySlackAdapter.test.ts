/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-assignment -- Test doubles mirror the adapter's declared protected payload shapes; recording the raw calls is the point of the test double. */
import { assert, it } from '@effect/vitest'
import type { SlackAdapterMode, SlackSessionTitle } from '@chat-adapter/slack'
import * as Effect from 'effect/Effect'

import type { SlackResolvedChannelPolicy } from './SlackChannelAccess.ts'
import { FridaySlackAdapter } from './FridaySlackAdapter.ts'

const TEAM = 'T123'
const CHANNEL = 'C456'
const OTHER_TEAM = 'T999'
const USER = 'U111'

const allowAll: SlackResolvedChannelPolicy = {
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
}

/**
 * Recording adapter that stubs the Chat dispatch points, so tests observe
 * exactly what the adapter does at the Socket Mode boundary: whether an
 * event reaches the Chat handlers or is dropped by the fail-closed policy
 * gate first. The stubbed chat only records; message factories are never
 * invoked, so no parsing or network happens.
 */
class RecordingFridaySlackAdapter extends FridaySlackAdapter {
  readonly processedMessages: Array<unknown> = []
  readonly startedThreads: Array<unknown> = []
  readonly changedContexts: Array<unknown> = []
  readonly changedTitles: Array<unknown> = []
  readonly openedHomes: Array<unknown> = []
  readonly changedAppContexts: Array<unknown> = []
  readonly joinedMembers: Array<unknown> = []

  /** Installs recording stand-ins for the Chat dispatch points. */
  attachRecordingChat(): void {
    // SAFETY: the adapter only calls these Chat entry points from the
    // handlers under test; the recordings capture exactly those calls.
    this.chat = {
      processMessage: async (_adapter: unknown, threadId: string) => {
        this.processedMessages.push(threadId)
      },
      getState: () => ({
        isSubscribed: async () => false,
      }),
      processAssistantThreadStarted: async (input: unknown) => {
        this.startedThreads.push(input)
      },
      processAssistantContextChanged: async (input: unknown) => {
        this.changedContexts.push(input)
      },
      processAgentSessionTitleChanged: async (input: unknown) => {
        this.changedTitles.push(input)
      },
      processAppHomeOpened: async (input: unknown) => {
        this.openedHomes.push(input)
      },
      processAppContextChanged: async (input: unknown) => {
        this.changedAppContexts.push(input)
      },
      processMemberJoinedChannel: async (input: unknown) => {
        this.joinedMembers.push(input)
      },
    } as never
  }

  get sessionTitleSetting(): SlackSessionTitle {
    return this.sessionTitle
  }

  get agentViewSetting(): boolean {
    return this.agentView
  }

  get modeSetting(): SlackAdapterMode {
    return this.mode
  }

  /** Exposes the protected message entry point for the test. */
  runMessageEvent(event: unknown): void {
    // SAFETY: Socket Mode delivers decoded Slack message events here.
    super.handleMessageEvent(event as never)
  }

  /** Exposes the protected assistant-thread entry point for the test. */
  runAssistantThreadStarted(event: unknown): void {
    // SAFETY: the adapter receives assistant_thread_started payloads here.
    super.handleAssistantThreadStarted(event as never)
  }

  /** Exposes the protected assistant-context entry point for the test. */
  runAssistantContextChanged(event: unknown): void {
    // SAFETY: the adapter receives assistant_thread_context_changed payloads here.
    super.handleAssistantContextChanged(event as never)
  }

  /** Exposes the protected session-title entry point for the test. */
  runAgentSessionTitleChanged(event: unknown): void {
    // SAFETY: the adapter receives agent_session_title_changed payloads here.
    super.handleAgentSessionTitleChanged(event as never)
  }

  /** Exposes the protected Home-tab entry point for the test. */
  runAppHomeOpened(event: unknown, teamId?: string): void {
    // SAFETY: the adapter receives app_home_opened payloads here.
    super.handleAppHomeOpened(event as never, undefined, teamId)
  }

  /** Exposes the protected active-view context entry point for the test. */
  runAppContextChanged(event: unknown): void {
    // SAFETY: the adapter receives app_context_changed payloads here.
    super.handleAppContextChanged(event as never)
  }

  /** Exposes the protected member-joined entry point for the test. */
  runMemberJoinedChannel(event: unknown): void {
    // SAFETY: the adapter receives member_joined_channel payloads here.
    super.handleMemberJoinedChannel(event as never)
  }
}

const adapterWith = (
  resolveChannelPolicy: (
    teamId: string,
    channelId: string,
  ) => SlackResolvedChannelPolicy | undefined,
): RecordingFridaySlackAdapter => {
  const adapter = new RecordingFridaySlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    resolveChannelPolicy,
  })
  adapter.attachRecordingChat()
  return adapter
}

const allowTeam = (teamId: string, channelId: string) =>
  teamId === TEAM && channelId === CHANNEL ? allowAll : undefined

const messageEvent = (
  overrides: {
    readonly team_id?: string
    readonly team?: string
    readonly channel?: string
    readonly user?: string
    readonly text?: string
    readonly ts?: string
  } = {},
) => ({
  type: 'message',
  team_id: TEAM,
  team: TEAM,
  channel: CHANNEL,
  user: USER,
  text: 'hello Friday',
  ts: '1234567890.111111',
  ...overrides,
})

const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0))

it('fixes the Agent/AI experience over Socket Mode without auto titles', () => {
  const adapter = adapterWith(allowTeam)
  assert.strictEqual(adapter.isSocketMode, true)
  assert.strictEqual(adapter.agentViewSetting, true)
  assert.strictEqual(adapter.modeSetting, 'socket')
  // Friday titles stay explicit through setConversationTitle; the adapter
  // must never title sessions on its own.
  assert.strictEqual(adapter.sessionTitleSetting, false)
})

it.effect('forwards admitted channel messages to Chat state', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)

    adapter.runMessageEvent(messageEvent())
    await flushTasks()

    assert.deepStrictEqual(adapter.processedMessages, ['slack:C456:1234567890.111111'])
  }),
)

it.effect('drops messages from unknown or disabled locations before Chat state', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)

    adapter.runMessageEvent(messageEvent({ team_id: OTHER_TEAM, team: OTHER_TEAM }))
    adapter.runMessageEvent(messageEvent({ channel: 'C000' }))
    adapter.runMessageEvent(messageEvent({ team_id: '', team: '' }))
    adapter.runMessageEvent(messageEvent({ channel: '' }))
    await flushTasks()

    assert.deepStrictEqual(adapter.processedMessages, [])
  }),
)

it.effect('reads the team from either Slack team shape', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)

    // team_id alone suffices when team is absent, and vice versa.
    const { team: _droppedTeam, ...withoutTeam } = messageEvent()
    adapter.runMessageEvent({ ...withoutTeam, team_id: TEAM })
    const { team_id: _droppedTeamId, ...withoutTeamId } = messageEvent()
    adapter.runMessageEvent({ ...withoutTeamId, team: TEAM })
    await flushTasks()

    assert.strictEqual(adapter.processedMessages.length, 2)
  }),
)

it.effect('drops empty teams and channels even for permissive policies', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(() => allowAll)

    adapter.runMessageEvent(messageEvent({ team_id: '', team: '' }))
    adapter.runMessageEvent(messageEvent({ channel: '' }))
    await flushTasks()

    assert.deepStrictEqual(adapter.processedMessages, [])
  }),
)

it.effect('admits authorless events past the user gate', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)
    const { user: _droppedUser, ...withoutUser } = messageEvent()

    adapter.runMessageEvent(withoutUser)
    await flushTasks()

    // No user means no denial; invocation is decided downstream.
    assert.strictEqual(adapter.processedMessages.length, 1)
  }),
)

it.effect('drops denied users before Chat state', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(() => ({
      ...allowAll,
      users: { mode: 'deny', ids: [USER] },
    }))

    adapter.runMessageEvent(messageEvent())
    await flushTasks()

    assert.deepStrictEqual(adapter.processedMessages, [])
  }),
)

it.effect('gates assistant threads on team, channel, and user', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)
    const started = () => ({
      assistant_thread: {
        channel_id: CHANNEL,
        thread_ts: '1234567890.111111',
        user_id: USER,
        context: { team_id: TEAM },
      },
    })

    adapter.runAssistantThreadStarted(started())
    adapter.runAssistantContextChanged(started())
    await flushTasks()
    assert.strictEqual(adapter.startedThreads.length, 1)
    assert.strictEqual(adapter.changedContexts.length, 1)

    // Unknown teams never reach Chat state.
    const foreign = started()
    foreign.assistant_thread.context.team_id = OTHER_TEAM
    adapter.runAssistantThreadStarted(foreign)
    adapter.runAssistantContextChanged(foreign)
    // Events without a thread payload are ignored.
    adapter.runAssistantThreadStarted({ type: 'assistant_thread_started' })
    adapter.runAssistantContextChanged({ type: 'assistant_thread_context_changed' })
    await flushTasks()
    assert.strictEqual(adapter.startedThreads.length, 1)
    assert.strictEqual(adapter.changedContexts.length, 1)

    const denied = adapterWith(() => ({
      ...allowAll,
      users: { mode: 'deny', ids: [USER] },
    }))
    denied.runAssistantThreadStarted(started())
    denied.runAssistantContextChanged(started())
    await flushTasks()
    assert.deepStrictEqual(denied.startedThreads, [])
    assert.deepStrictEqual(denied.changedContexts, [])
  }),
)

it.effect('gates session title changes on the resolved policy', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)
    const titleChanged = { team_id: TEAM, channel: CHANNEL, user: USER }

    adapter.runAgentSessionTitleChanged(titleChanged)
    await flushTasks()
    assert.strictEqual(adapter.changedTitles.length, 1)

    adapter.runAgentSessionTitleChanged({ ...titleChanged, team_id: OTHER_TEAM })
    await flushTasks()
    assert.strictEqual(adapter.changedTitles.length, 1)
  }),
)

it.effect('gates Home opens only when the team is known', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)
    const home = { channel: CHANNEL, user: USER, tab: 'home' }

    adapter.runAppHomeOpened(home, TEAM)
    await flushTasks()
    assert.strictEqual(adapter.openedHomes.length, 1)

    adapter.runAppHomeOpened(home, OTHER_TEAM)
    await flushTasks()
    assert.strictEqual(adapter.openedHomes.length, 1)

    // Without a team the event flows through for observability.
    adapter.runAppHomeOpened(home)
    await flushTasks()
    assert.strictEqual(adapter.openedHomes.length, 2)

    // A blank team is not a known team either.
    adapter.runAppHomeOpened(home, '')
    await flushTasks()
    assert.strictEqual(adapter.openedHomes.length, 3)
  }),
)

it.effect('passes observability-only events through to Chat state', () =>
  Effect.promise(async () => {
    const adapter = adapterWith(allowTeam)

    adapter.runAppContextChanged({ channel: CHANNEL, user: USER })
    adapter.runMemberJoinedChannel({ channel: CHANNEL, user: USER })
    await flushTasks()

    assert.strictEqual(adapter.changedAppContexts.length, 1)
    assert.strictEqual(adapter.joinedMembers.length, 1)
  }),
)
