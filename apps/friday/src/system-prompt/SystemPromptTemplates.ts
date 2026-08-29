import type { ChannelThread, ModelSelection } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

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
  readonly availableAgentModels: ReadonlyArray<ModelSelection>
}

export interface SystemPromptTemplatesContract {
  readonly renderChannelAgent: (
    context: ChannelAgentSystemPromptContext,
  ) => Effect.Effect<string, SystemPromptTemplateError>
  readonly renderBootstrapAgent: Effect.Effect<string, SystemPromptTemplateError>
}

export class SystemPromptTemplates extends Context.Service<
  SystemPromptTemplates,
  SystemPromptTemplatesContract
>()('friday/system-prompt/SystemPromptTemplates') {}

const TemplateVariable = /{{([A-Za-z][A-Za-z0-9]*)}}/g

const renderTemplate = (
  template: 'channel-agent' | 'bootstrap-agent',
  source: string,
  variables: Readonly<Record<string, string>>,
): Effect.Effect<string, SystemPromptTemplateError> =>
  Effect.gen(function* () {
    const referenced = new Set(
      Array.from(source.matchAll(TemplateVariable), (match) => match[1]).filter(
        (variable): variable is string => variable !== undefined,
      ),
    )
    const missing = Array.from(referenced).filter((variable) => variables[variable] === undefined)
    if (missing.length > 0) {
      return yield* new SystemPromptTemplateError({
        template,
        detail: `Missing template variables: ${missing.join(', ')}`,
      })
    }
    const rendered = source.replaceAll(
      TemplateVariable,
      (_, variable: string) => variables[variable] ?? '',
    )
    const unresolved = Array.from(rendered.matchAll(TemplateVariable), (match) => match[1]).filter(
      (variable): variable is string => variable !== undefined,
    )
    if (unresolved.length > 0) {
      return yield* new SystemPromptTemplateError({
        template,
        detail: `Unresolved template variables: ${unresolved.join(', ')}`,
      })
    }
    return rendered.trim()
  })

const renderAvailableModels = (models: ReadonlyArray<ModelSelection>): string =>
  models.length === 0
    ? '(No agent models are configured.)'
    : models
        .map(({ provider, modelId }, index) =>
          index === 0 ? `- Default: \`${provider}/${modelId}\`` : `- \`${provider}/${modelId}\``,
        )
        .join('\n')

export const SystemPromptTemplatesLive = Layer.succeed(
  SystemPromptTemplates,
  SystemPromptTemplates.of({
    renderChannelAgent: (context) =>
      renderTemplate('channel-agent', channelAgentTemplate, {
        platform: context.thread.conversationBinding.platform,
        channelName: context.thread.channelContext.name,
        channelDescription: context.thread.channelContext.description || '(No channel description)',
        currentWorkingDirectory: context.thread.workingDirectory,
        availableAgentModels: renderAvailableModels(context.availableAgentModels),
      }),
    renderBootstrapAgent: renderTemplate('bootstrap-agent', bootstrapAgentTemplate, {}),
  }),
)
