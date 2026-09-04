import {
  Activity,
  ActivityId,
  AgentThread,
  PlatformKind,
  PlatformConnectionId,
  PlatformConversationId,
  type PlatformKind as PlatformKindType,
  type PlatformConnectionId as PlatformConnectionIdType,
  type PlatformConversationId as PlatformConversationIdType,
  Thread,
  ThreadId,
  Turn,
  TurnId,
  type Activity as ActivityType,
  type Thread as ThreadType,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import { PersistenceDecodeError, PersistenceSqlError } from './Errors.ts'
import { runMigrations } from './Migrations.ts'

const ThreadJson = Schema.fromJsonString(Thread)
const AgentThreadJson = Schema.fromJsonString(AgentThread)
const TurnJson = Schema.fromJsonString(Turn)
const ActivityJson = Schema.fromJsonString(Activity)
const encodeThreadJson = Schema.encodeEffect(ThreadJson)
const encodeTurnJson = Schema.encodeEffect(TurnJson)
const encodeActivityJson = Schema.encodeEffect(ActivityJson)

const GetThreadRequest = Schema.Struct({ threadId: ThreadId })
const FindPlatformThreadRequest = Schema.Struct({
  platform: PlatformKind,
  connectionId: PlatformConnectionId,
  conversationId: PlatformConversationId,
})
const ListAgentThreadsRequest = Schema.Struct({ parentThreadId: ThreadId })
const GetTurnRequest = Schema.Struct({ turnId: TurnId })
const GetFirstTurnRequest = Schema.Struct({ threadId: ThreadId })
const GetLatestTurnRequest = Schema.Struct({ threadId: ThreadId })
const GetLatestUserTurnRequest = Schema.Struct({ threadId: ThreadId })
const GetActivityRequest = Schema.Struct({ activityId: ActivityId })
const PersistedThreadRow = Schema.Struct({ payload: ThreadJson })
const PersistedAgentThreadRow = Schema.Struct({ payload: AgentThreadJson })
const PersistedTurnRow = Schema.Struct({ payload: TurnJson })
const PersistedActivityRow = Schema.Struct({ payload: ActivityJson })

const toPersistenceError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({
        operation,
        detail: `Failed to execute ${operation}`,
        cause,
      })

export const makeSqliteThreadPersistence = Effect.fn('makeSqliteThreadPersistence')(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* runMigrations().pipe(Effect.mapError(toPersistenceError('ThreadPersistence.migrate')))

  const insertThread = (thread: ThreadType) =>
    encodeThreadJson(thread).pipe(
      Effect.flatMap(
        (payload) => sql`
        INSERT INTO threads (
          thread_id,
          audience,
          status,
          payload_json,
          created_at,
          updated_at,
          closed_at
        ) VALUES (
          ${thread.id},
          ${thread.audience},
          ${thread.status},
          ${payload},
          ${thread.createdAt},
          ${thread.updatedAt},
          ${thread.closedAt}
        )
      `,
      ),
      Effect.asVoid,
    )

  const updateThread = (thread: ThreadType) =>
    encodeThreadJson(thread).pipe(
      Effect.flatMap(
        (payload) => sql`
        UPDATE threads
        SET
          status = ${thread.status},
          payload_json = ${payload},
          updated_at = ${thread.updatedAt},
          closed_at = ${thread.closedAt}
        WHERE thread_id = ${thread.id}
      `,
      ),
      Effect.asVoid,
    )

  const insertTurn = (turn: TurnType) =>
    encodeTurnJson(turn).pipe(
      Effect.flatMap(
        (payload) => sql`
        INSERT INTO turns (
          turn_id,
          thread_id,
          sequence,
          status,
          payload_json,
          requested_at,
          started_at,
          completed_at
        ) VALUES (
          ${turn.id},
          ${turn.threadId},
          ${turn.sequence},
          ${turn.status},
          ${payload},
          ${turn.requestedAt},
          ${turn.startedAt},
          ${turn.completedAt}
        )
      `,
      ),
      Effect.asVoid,
    )

  const updateTurn = (turn: TurnType) =>
    encodeTurnJson(turn).pipe(
      Effect.flatMap(
        (payload) => sql`
        UPDATE turns
        SET
          status = ${turn.status},
          payload_json = ${payload},
          started_at = ${turn.startedAt},
          completed_at = ${turn.completedAt}
        WHERE turn_id = ${turn.id}
      `,
      ),
      Effect.asVoid,
    )

  const selectThread = SqlSchema.findOneOption({
    Request: GetThreadRequest,
    Result: PersistedThreadRow,
    execute: ({ threadId }) => sql`
      SELECT payload_json AS payload
      FROM threads
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  })

  const findPlatformThread = SqlSchema.findOneOption({
    Request: FindPlatformThreadRequest,
    Result: PersistedThreadRow,
    execute: ({ platform, connectionId, conversationId }) => sql`
      SELECT payload_json AS payload
      FROM threads
      WHERE audience = 'user'
        AND status = 'active'
        AND json_extract(payload_json, '$.conversationBinding.platform') = ${platform}
        AND json_extract(payload_json, '$.conversationBinding.connectionId') = ${connectionId}
        AND json_extract(payload_json, '$.conversationBinding.conversationId') = ${conversationId}
      LIMIT 1
    `,
  })

  const selectAgentThreads = SqlSchema.findAll({
    Request: ListAgentThreadsRequest,
    Result: PersistedAgentThreadRow,
    execute: ({ parentThreadId }) => sql`
      SELECT payload_json AS payload
      FROM threads
      WHERE audience = 'agent'
        AND json_extract(payload_json, '$.parent.threadId') = ${parentThreadId}
      ORDER BY created_at ASC, thread_id ASC
    `,
  })

  const selectTurn = SqlSchema.findOneOption({
    Request: GetTurnRequest,
    Result: PersistedTurnRow,
    execute: ({ turnId }) => sql`
      SELECT payload_json AS payload
      FROM turns
      WHERE turn_id = ${turnId}
      LIMIT 1
    `,
  })

  const selectFirstTurn = SqlSchema.findOneOption({
    Request: GetFirstTurnRequest,
    Result: PersistedTurnRow,
    execute: ({ threadId }) => sql`
      SELECT payload_json AS payload
      FROM turns
      WHERE thread_id = ${threadId}
      ORDER BY sequence ASC
      LIMIT 1
    `,
  })

  const selectLatestTurn = SqlSchema.findOneOption({
    Request: GetLatestTurnRequest,
    Result: PersistedTurnRow,
    execute: ({ threadId }) => sql`
      SELECT payload_json AS payload
      FROM turns
      WHERE thread_id = ${threadId}
      ORDER BY sequence DESC
      LIMIT 1
    `,
  })

  const selectLatestUserTurn = SqlSchema.findOneOption({
    Request: GetLatestUserTurnRequest,
    Result: PersistedTurnRow,
    execute: ({ threadId }) => sql`
      SELECT payload_json AS payload
      FROM turns
      WHERE thread_id = ${threadId}
        AND json_extract(payload_json, '$.input.source') = 'user'
        AND json_extract(payload_json, '$.input.platformMessageId') IS NOT NULL
      ORDER BY sequence DESC
      LIMIT 1
    `,
  })

  const selectActivity = SqlSchema.findOneOption({
    Request: GetActivityRequest,
    Result: PersistedActivityRow,
    execute: ({ activityId }) => sql`
      SELECT payload_json AS payload
      FROM activities
      WHERE activity_id = ${activityId}
      LIMIT 1
    `,
  })

  const getThread = (threadId: ThreadType['id']) =>
    selectThread({ threadId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getThread')),
    )

  const findActivePlatformThread = (lookup: {
    readonly platform: PlatformKindType
    readonly connectionId: PlatformConnectionIdType
    readonly conversationId: PlatformConversationIdType
  }) =>
    findPlatformThread(lookup).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.findPlatformThread')),
    )

  const listAgentThreads = (parentThreadId: ThreadType['id']) =>
    selectAgentThreads({ parentThreadId }).pipe(
      Effect.map((rows) => rows.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.listAgentThreads')),
    )

  const getTurn = (turnId: TurnType['id']) =>
    selectTurn({ turnId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getTurn')),
    )

  const getFirstTurn = (threadId: ThreadType['id']) =>
    selectFirstTurn({ threadId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getFirstTurn')),
    )

  const getLatestTurn = (threadId: ThreadType['id']) =>
    selectLatestTurn({ threadId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getLatestTurn')),
    )

  const getLatestUserTurn = (threadId: ThreadType['id']) =>
    selectLatestUserTurn({ threadId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getLatestUserTurn')),
    )

  const getActivity = (activityId: ActivityType['id']) =>
    selectActivity({ activityId }).pipe(
      Effect.map(Option.map((row) => row.payload)),
      Effect.mapError(toPersistenceError('ThreadPersistence.getActivity')),
    )

  const updateExistingTurn = (
    operation: string,
    turnId: TurnType['id'],
    update: (turn: TurnType) => TurnType,
  ) =>
    Effect.gen(function* () {
      const existing = yield* getTurn(turnId)
      if (Option.isNone(existing)) return
      yield* updateTurn(update(existing.value))
    }).pipe(Effect.mapError(toPersistenceError(operation)))

  const putActivitySnapshot = Effect.fn('putActivitySnapshot')(function* (
    turnId: TurnType['id'],
    activity: ActivityType,
  ) {
    const existing = yield* getActivity(activity.id)
    const nextSequence = Option.isSome(existing)
      ? existing.value.sequence
      : Number(
          (yield* sql<{ readonly next_sequence: number }>`
            SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence
            FROM activities
            WHERE turn_id = ${turnId}
          `)[0]?.next_sequence ?? 0,
        )
    const normalizedActivity: ActivityType = {
      ...activity,
      sequence: nextSequence,
    }
    const payload = yield* encodeActivityJson(normalizedActivity)

    yield* sql`
      INSERT INTO activities (
        activity_id,
        turn_id,
        sequence,
        type,
        status,
        payload_json,
        created_at,
        updated_at,
        completed_at
      ) VALUES (
        ${normalizedActivity.id},
        ${turnId},
        ${normalizedActivity.sequence},
        ${normalizedActivity.type},
        ${normalizedActivity.status},
        ${payload},
        ${normalizedActivity.createdAt},
        ${normalizedActivity.updatedAt},
        ${normalizedActivity.completedAt}
      )
      ON CONFLICT (activity_id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
      WHERE activities.status = 'active'
        AND activities.turn_id = excluded.turn_id
        AND activities.sequence = excluded.sequence
        AND activities.type = excluded.type
    `

    const persisted = yield* getActivity(activity.id)
    if (Option.isNone(persisted)) return

    yield* updateExistingTurn(
      'ThreadPersistence.putActivitySnapshot:updateTurn',
      turnId,
      (turn) => ({
        ...turn,
        activities: [
          ...turn.activities.filter(({ id }) => id !== persisted.value.id),
          persisted.value,
        ].toSorted((left, right) => left.sequence - right.sequence),
      }),
    )
  })

  return {
    createThread: (thread) =>
      insertThread(thread).pipe(
        Effect.mapError(toPersistenceError('ThreadPersistence.createThread')),
      ),
    getThread,
    findPlatformThread: findActivePlatformThread,
    listAgentThreads: ({ parentThreadId }) => listAgentThreads(parentThreadId),
    closeThread: (update) =>
      Effect.gen(function* () {
        const existing = yield* getThread(update.threadId)
        if (Option.isNone(existing)) return
        yield* updateThread({
          ...existing.value,
          status: 'closed',
          updatedAt: update.closedAt,
          closedAt: update.closedAt,
        })
      }).pipe(Effect.mapError(toPersistenceError('ThreadPersistence.closeThread'))),
    setThreadHarnessSession: (update) =>
      Effect.gen(function* () {
        const existing = yield* getThread(update.threadId)
        if (Option.isNone(existing)) return
        yield* updateThread({
          ...existing.value,
          harnessSession: update.harnessSession,
        })
      }).pipe(Effect.mapError(toPersistenceError('ThreadPersistence.setThreadHarnessSession'))),
    createTurn: (turn) =>
      insertTurn(turn).pipe(Effect.mapError(toPersistenceError('ThreadPersistence.createTurn'))),
    getTurn,
    getFirstTurn,
    getLatestTurn,
    getLatestUserTurn,
    startTurn: (update) =>
      updateExistingTurn('ThreadPersistence.startTurn', update.turnId, (turn) => ({
        ...turn,
        harnessTurnId: update.harnessTurnId,
        status: 'running',
        startedAt: update.startedAt,
      })),
    putActivitySnapshot: (turnId, activity) =>
      sql
        .withTransaction(putActivitySnapshot(turnId, activity))
        .pipe(Effect.mapError(toPersistenceError('ThreadPersistence.putActivitySnapshot'))),
    getActivity,
    completeTurn: (update) =>
      updateExistingTurn('ThreadPersistence.completeTurn', update.turnId, (turn) => ({
        ...turn,
        agentMessage: update.agentMessage,
        status: 'completed',
        completedAt: update.completedAt,
        usage: update.usage,
      })),
    interruptTurn: (update) =>
      updateExistingTurn('ThreadPersistence.interruptTurn', update.turnId, (turn) => ({
        ...turn,
        agentMessage: update.agentMessage,
        status: 'interrupted',
        completedAt: update.completedAt,
        usage: update.usage,
      })),
    failTurn: (update) =>
      updateExistingTurn('ThreadPersistence.failTurn', update.turnId, (turn) => ({
        ...turn,
        status: 'failed',
        completedAt: update.completedAt,
        errorMessage: update.errorMessage,
      })),
  } satisfies ThreadPersistenceContract
})
