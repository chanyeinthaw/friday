import type { Context as PiContext, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Static, TSchema } from '@earendil-works/pi-ai'
import {
  Harness,
  defineTool,
  type HarnessOptions,
  type Storage,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'

import { PiDurableError } from './PiDurableError.ts'
export { PiDurableError } from './PiDurableError.ts'

/** Interrupting a wait cancels that wait; admitted durable work remains owned by Pi. */
export const piOperation = <A>(operation: string, call: (context: PiContext) => Promise<A>) =>
  Effect.tryPromise({
    try: (signal) => call(withAbortSignal(signal, BACKGROUND_CONTEXT)),
    catch: (cause) => new PiDurableError({ operation, cause }),
  })

/** The caller's scope owns the harness; provide storage in an enclosing scope. */
export const openHarness = <Tool extends ToolRegistration>(
  storage: Storage,
  options: HarnessOptions<Tool>,
) =>
  Effect.acquireRelease(
    piOperation('open', (context) => Harness.open(storage, options, context)),
    (harness) => piOperation('close', (context) => harness.close(context)).pipe(Effect.orDie),
  )

/** Runs an Effect callback for the lifetime of the SDK invocation. */
export const runPiEffect = <A, E>(effect: Effect.Effect<A, E>, context: PiContext) =>
  Effect.runPromise(effect, { signal: context.abortSignal })

/** Capture services once during extension construction, before Pi invokes its callbacks. */
export const makePiRunner = <R>() =>
  Effect.gen(function* () {
    const services = yield* Effect.context<R>()
    return <A, E>(effect: Effect.Effect<A, E, R>, context: PiContext) =>
      runPiEffect(effect.pipe(Effect.provide(services)), context)
  })

export type EffectTool<TParameters extends TSchema, TDetails extends JsonValue, E> = Omit<
  ToolRegistration<TParameters, TDetails>,
  'execute'
> & {
  readonly execute: (
    args: Static<TParameters>,
    api: ToolExecutionApi<TDetails>,
    context: PiContext,
  ) => Effect.Effect<ToolExecutionResult<TDetails>, E>
}

/** Keep Pi's parameter inference, replay policy, streaming API, and result types. */
export const defineEffectTool = <TParameters extends TSchema, TDetails extends JsonValue, E>(
  tool: EffectTool<TParameters, TDetails, E>,
) =>
  defineTool({
    ...tool,
    execute: (args, api, context) =>
      runPiEffect(
        Effect.suspend(() => tool.execute(args, api, context)),
        context,
      ),
  })
