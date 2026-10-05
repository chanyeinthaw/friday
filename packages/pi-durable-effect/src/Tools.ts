import {
  createRegistry,
  defineExtension,
  section,
  type AgentChange,
  type AnyTask,
  type PromptInput,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import * as Effect from 'effect/Effect'

import { PiDurableError } from './PiDurableError.ts'
import { runPiEffect } from './Runtime.ts'

export const codingTools = CodingTools.tools ?? []

export interface ToolOptions<E> {
  readonly tools: readonly ToolRegistration[]
  readonly systemPrompt?: (input: PromptInput) => Effect.Effect<string, E>
  readonly tasks?: readonly AnyTask[]
}

/** Pi requires named extension registrations internally; callers supply tools and a prompt. */
export const createToolRegistry = () => {
  const registry = createRegistry()
  const provide = <E>(name: string, options: ToolOptions<E>) =>
    Effect.try({
      try: (): AgentChange => {
        const render = options.systemPrompt
        const extension = defineExtension({
          name,
          tools: options.tools,
          sections:
            render === undefined
              ? []
              : [
                  section(
                    'system_prompt',
                    (input, context) => runPiEffect(render(input), context),
                    {
                      tag: false,
                    },
                  ),
                ],
          tasks: options.tasks ?? [],
        })
        registry.install(extension)
        return { extensions: [extension], tools: options.tools }
      },
      catch: (cause) => new PiDurableError({ operation: 'provide-tools', cause }),
    })
  return { registry, provide }
}
