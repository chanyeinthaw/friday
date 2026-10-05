import {
  ActivityId,
  ToolCallId,
  type Activity,
  type Thread,
  type Turn,
  type TurnId,
} from '@friday/contracts/conversation'
import type { EntryRecord, ToolSlot } from '@earendil-works/pi-durable'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ConversationEvent } from '../../conversation/ConversationEvents.ts'
import type { ThreadPersistenceContract } from '../../conversation/ThreadPersistence.ts'

const activityId = Schema.decodeSync(ActivityId)
const toolCallId = Schema.decodeSync(ToolCallId)
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json))

/** Rebuilds activity snapshots from committed facts, including on late attachment or watch overflow. */
export const projectPiActivities = Effect.fn('PiDurable.projectActivities')(function* (input: {
  readonly thread: Thread
  readonly turnId: TurnId
  readonly entries: readonly EntryRecord[]
  readonly tools: readonly ToolSlot[]
  readonly persistence: ThreadPersistenceContract
  readonly emit: (event: ConversationEvent) => Effect.Effect<void>
}) {
  const stored = yield* input.persistence.getTurn(input.turnId)
  if (Option.isNone(stored)) return
  const turn: Turn = stored.value
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
  let nextSequence = turn.activities.reduce(
    (next, activity) => Math.max(next, activity.sequence + 1),
    0,
  )

  const save = Effect.fn('PiDurable.saveActivity')(function* (candidate: Activity) {
    const previous = yield* input.persistence.getActivity(candidate.id)
    const activity: Activity = Option.isSome(previous)
      ? { ...candidate, sequence: previous.value.sequence, createdAt: previous.value.createdAt }
      : { ...candidate, sequence: nextSequence++ }
    if (
      Option.isSome(previous) &&
      previous.value.status === activity.status &&
      JSON.stringify({ ...previous.value, updatedAt: null, completedAt: null }) ===
        JSON.stringify({ ...activity, updatedAt: null, completedAt: null })
    )
      return
    yield* input.persistence.putActivitySnapshot(input.turnId, activity)
    yield* input.emit({
      type:
        activity.status === 'completed'
          ? 'activity-completed'
          : Option.isSome(previous)
            ? 'activity-updated'
            : 'activity-started',
      turnId: input.turnId,
      activity,
    })
  })

  const messages = input.entries.flatMap((entry) => entry.model ?? [])
  for (const entry of input.entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== 'assistant') continue
      for (const call of message.content) {
        if (call.type !== 'toolCall') continue
        const callId = toolCallId(call.id)
        const base = { sequence: 0, createdAt: now, updatedAt: now, completedAt: now }
        yield* save({
          ...base,
          id: activityId(`pi-${entry.id}-${call.id}-call`),
          status: 'completed',
          type: 'tool-call',
          callId,
          toolName: call.name,
          input: decodeJson(JSON.stringify(call.arguments)),
        })
        const result = messages.find(
          (item) => item.role === 'toolResult' && item.toolCallId === call.id,
        )
        const slot = input.tools.find((tool) => tool.callId === call.id)
        const completed = result !== undefined || slot?.status === 'done'
        const output =
          result?.role === 'toolResult'
            ? result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
            : (slot?.output ?? null)
        yield* save({
          ...base,
          id: activityId(`pi-${entry.id}-${call.id}-result`),
          type: 'tool-result',
          callId,
          status: completed ? 'completed' : 'active',
          completedAt: completed ? now : null,
          output,
          isError:
            result?.role === 'toolResult'
              ? result.isError
              : slot?.status === 'done' && slot.entry === undefined,
        })
      }
    }
  }
})
