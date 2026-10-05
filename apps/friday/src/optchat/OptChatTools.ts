import { Type } from '@earendil-works/pi-ai'
import { defineEffectTool } from '@friday/pi-durable-effect'
import * as Effect from 'effect/Effect'
import type { OptChatMemory } from './OptChatMemory.ts'

export const makeOptChatTools = (memory: OptChatMemory, memoryId: string) => [
  defineEffectTool({
    name: 'zoom',
    description:
      'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    replay: 'safe',
    execute: Effect.fn('OptChat.zoomTool')(function* ({ id, n }) {
      return { content: [{ type: 'text' as const, text: yield* memory.zoom(memoryId, id, n) }] }
    }),
  }),
  defineEffectTool({
    name: 'date',
    description: 'The date and time of message id.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    replay: 'safe',
    execute: Effect.fn('OptChat.dateTool')(function* ({ id }) {
      return { content: [{ type: 'text' as const, text: yield* memory.date(memoryId, id) }] }
    }),
  }),
]
