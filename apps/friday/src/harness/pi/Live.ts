import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

export class PiModelRuntime extends Context.Service<PiModelRuntime, ModelRuntime>()(
  'friday/harness/pi/PiModelRuntime',
) {}

export const PiModelRuntimeLive = Layer.effect(
  PiModelRuntime,
  Effect.promise(() =>
    ModelRuntime.create({
      allowModelNetwork: false,
    }),
  ),
)
