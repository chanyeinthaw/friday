import type { ChannelThread, Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import type { SubagentProfile } from '../config/AppConfig.ts'
import { FRIDAY_CLI_PATH } from '../FridayHome.ts'
import bootstrapAgentTemplate from './templates/bootstrap-agent.md' with { type: 'text' }
import channelAgentTemplate from './templates/channel-agent.md' with { type: 'text' }

export class SystemPromptTemplateError extends Schema.Error<SystemPromptTemplateError>(
  'SystemPromptTemplateError',
)({
  _tag: Schema.tag('SystemPromptTemplateError'),
  template: Schema.Literals(['channel-agent', 'bootstrap-agent']),
  detail: Schema.String,
}) {}

export interface ChannelAgentSystemPromptContext {
  readonly thread: ChannelThread
  readonly availableAgentModels: ReadonlyArray<SubagentProfile>
}

export interface SystemPromptTemplatesContract {
  readonly renderChannelAgent: (
    context: ChannelAgentSystemPromptContext,
  ) => Effect.Effect<string, SystemPromptTemplateError>
  readonly renderBootstrapAgent: (
    currentWorkingDirectory: string,
  ) => Effect.Effect<string, SystemPromptTemplateError>
}

export class SystemPromptTemplates extends Context.Service<
  SystemPromptTemplates,
  SystemPromptTemplatesContract
>()('friday/system-prompt/SystemPromptTemplates') {}

const TemplateVariable = /{{([A-Za-z][A-Za-z0-9]*)}}/g

const unresolvedVariables = (source: string): ReadonlyArray<string> =>
  Array.from(source.matchAll(TemplateVariable), ([, variable]) => variable ?? '')

const renderTemplate = (
  template: 'channel-agent' | 'bootstrap-agent',
  source: string,
  variables: Readonly<Record<string, string>>,
): Effect.Effect<string, SystemPromptTemplateError> =>
  Effect.gen(function* () {
    let rendered = source
    for (const [variable, value] of Object.entries(variables)) {
      rendered = rendered.replaceAll(`{{${variable}}}`, value)
    }
    const unresolved = unresolvedVariables(rendered)
    if (unresolved.length > 0) {
      return yield* new SystemPromptTemplateError({
        template,
        detail: `Missing template variables: ${unresolved.join(',')}`,
      })
    }
    return rendered.trim()
  })

export const renderModelHint = (thread: Thread): string =>
  `## Runtime model\n\n- Model: \`${thread.model.provider}/${thread.model.modelId}\`\n- Thinking level: \`${thread.thinkingLevel}\``

const renderAvailableModels = (profiles: ReadonlyArray<SubagentProfile>): string =>
  profiles.length === 0
    ? '(No subagent profiles are configured.)'
    : profiles
        .map(
          ({ name, description, model, thinkingLevel }) =>
            `- \`${name}\`: ${description}\n  - Model: \`${model.provider}/${model.modelId}\`\n  - Thinking: \`${thinkingLevel}\`${name === 'primary' ? '\n  - Default' : ''}`,
        )
        .join('\n\n')

export const makeSystemPromptTemplates = (templates: {
  readonly channelAgent: string
  readonly bootstrapAgent: string
}): SystemPromptTemplatesContract =>
  SystemPromptTemplates.of({
    renderChannelAgent: (context) =>
      renderTemplate('channel-agent', templates.channelAgent, {
        platform: context.thread.conversationBinding.platform,
        channelName: context.thread.channelContext.name,
        channelDescription: context.thread.channelContext.description || '(No channel description)',
        currentWorkingDirectory: context.thread.workingDirectory,
        modelHint: renderModelHint(context.thread),
        availableAgentModels: renderAvailableModels(context.availableAgentModels),
        fridayCliPath: FRIDAY_CLI_PATH,
      }),
    renderBootstrapAgent: (currentWorkingDirectory) =>
      renderTemplate('bootstrap-agent', templates.bootstrapAgent, {
        currentWorkingDirectory,
        fridayCliPath: FRIDAY_CLI_PATH,
      }),
  })

export const SystemPromptTemplatesLive = Layer.succeed(
  SystemPromptTemplates,
  makeSystemPromptTemplates({
    channelAgent: channelAgentTemplate,
    bootstrapAgent: bootstrapAgentTemplate,
  }),
)
