import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable'

type ThreadIndex = { threads: Array<{ threadId: string; conversationId: ConversationId }> }

/** The index and conversation creation commit together, so a restart cannot create a second conversation. */
export const FridayThreads = defineDoc({
  kind: 'friday.threads',
  version: 1,
  scope: 'session',
  initial: (): ThreadIndex => ({ threads: [] }),
  checkpointWhen: () => true,
})

export const FridayConversation = defineDoc({
  kind: 'friday.conversation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ threadJson: '' }),
  checkpointWhen: () => true,
})

export type TurnReceipt = {
  turnJson: string
  submissionId: SubmissionId | null
  completionTaskId: TaskId<string> | null
  parentTurnId: string | null
  cancelled: boolean
  delivered: boolean
}

/** Delivery and cancellation survive process restarts independently of in-memory waiters. */
export const FridayTurn = defineDocFamily<TurnReceipt, string>({
  kind: 'friday.turn',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  family: true,
  initial: (turnJson) => ({
    turnJson,
    submissionId: null,
    completionTaskId: null,
    parentTurnId: null,
    cancelled: false,
    delivered: false,
  }),
  checkpointWhen: () => true,
})
