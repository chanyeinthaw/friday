import { Config, Effect, Layer } from 'effect'
import { foldRuntimeLayer } from './FoldRuntime.ts'
import { piRuntimeLayer } from './PiRuntime.ts'

export const agentRuntimeLayer = Layer.unwrap(
  Config.Literals(['pi', 'fold'], 'WEDNESDAY_AGENT_ENGINE').pipe(
    Config.withDefault('pi'),
    Effect.map((engine) => (engine === 'fold' ? foldRuntimeLayer : piRuntimeLayer)),
  ),
)
