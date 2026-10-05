import {
  DefaultResourceLoader,
  buildSystemPrompt,
  getAgentDir,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'

import { PiDurableError, piOperation } from './Runtime.ts'

export type PiResources = Pick<
  ResourceLoader,
  'getSystemPrompt' | 'getAppendSystemPrompt' | 'getAgentsFiles' | 'getSkills'
>

export interface ResourceOptions {
  readonly cwd: string
  readonly agentDir?: string
  readonly additionalSkillPaths?: readonly string[]
}

/** Delegate resolution and precedence to Pi; JavaScript extensions and themes stay disabled. */
export const loadPiResources = Effect.fn('PiResources.load')(function* (options: ResourceOptions) {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    noExtensions: true,
    noThemes: true,
    additionalSkillPaths: [...(options.additionalSkillPaths ?? [])],
  })
  yield* piOperation('load-resources', () => loader.reload())
  return loader
})

export interface ResourcePromptOptions {
  readonly cwd: string
  readonly selectedTools: readonly string[]
  readonly fallbackPrompt: string
  readonly sections?: Record<string, string>
}

/** Mirrors AgentSession._rebuildSystemPrompt inputs and calls Pi's unmodified renderer. */
export const buildResourcePrompt = Effect.fn('PiResources.systemPrompt')(
  (resources: PiResources, options: ResourcePromptOptions) =>
    Effect.try({
      try: () =>
        buildSystemPrompt({
          cwd: options.cwd,
          customPrompt: resources.getSystemPrompt() ?? options.fallbackPrompt,
          appendSystemPrompt: resources.getAppendSystemPrompt().join('\n\n'),
          contextFiles: resources.getAgentsFiles().agentsFiles,
          skills: resources.getSkills().skills,
          selectedTools: [...options.selectedTools],
          sections: options.sections ?? {},
        }),
      catch: (cause) => new PiDurableError({ operation: 'build-system-prompt', cause }),
    }),
)
