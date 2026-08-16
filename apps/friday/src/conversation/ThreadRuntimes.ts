import type { Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { ThreadRuntime } from './ThreadRuntime.ts'

export class ThreadRuntimeError extends Schema.Error<ThreadRuntimeError>('ThreadRuntimeError')({
  _tag: Schema.tag('ThreadRuntimeError'),
  operation: Schema.Literals(['open', 'prompt', 'events']),
  cause: Schema.Defect(),
}) {}

export interface ThreadRuntimesContract {
  readonly open: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadRuntime<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError,
    Scope.Scope
  >
}

export class ThreadRuntimes extends Context.Service<ThreadRuntimes, ThreadRuntimesContract>()(
  'friday/conversation/ThreadRuntimes',
) {}
