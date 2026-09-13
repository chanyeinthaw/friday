import type { ChannelThread, PlatformKind, Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import type { SubagentProfile } from '../config/AppConfig.ts'
import { DefaultIdentityText, type IdentityText } from '../config/IdentityConfiguration.ts'
import { FRIDAY_CLI_PATH } from '../FridayHome.ts'
import type { RootUser } from '../config/RootUsers.ts'
import { renderRootUsersSection } from '../identity/RootUsers.ts'
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
  /** Trusted operator text inserted literally into the channel prompt. */
  readonly identityText?: IdentityText
  /** Already scoped to this channel; never pass the full root-user registry. */
  readonly rootUsers?: ReadonlyArray<RootUser>
  /**
   * Typed platform input for the injected Platform context block. Defaults to
   * the conversation binding platform on the thread.
   */
  readonly platform?: PlatformKind
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
    // Check the source template only: identity and root-user values are
    // trusted operator text inserted literally and must never be re-scanned
    // for template variables or interpolated.
    const missing = unresolvedVariables(source).filter((variable) => !(variable in variables))
    if (missing.length > 0) {
      return yield* new SystemPromptTemplateError({
        template,
        detail: `Missing template variables: ${missing.join(',')}`,
      })
    }
    const rendered = source.replace(
      TemplateVariable,
      (match, variable: string) => variables[variable] ?? match,
    )
    return rendered.trim()
  })

export const renderModelHint = (thread: Thread): string =>
  `## Runtime model\n\n- Model: \`${thread.model.provider}/${thread.model.modelId}\`\n- Thinking level: \`${thread.thinkingLevel}\``

/** Concise platform behavior for the shared channel-agent prompt. Derived from the conversation binding platform. */
export const renderPlatformContext = (platform: PlatformKind): string => {
  switch (platform) {
    case 'slack':
      return [
        '- This conversation runs in Slack. It can represent a channel or a thread, based on routing and reply settings.',
        '- Friday supplies native mentions shaped like `<@U...>`. Copy a supplied mention exactly. Never build one from an ID or name.',
        '- You cannot see files or images for now. Work from message text and notes about attachments. Say what you could not see when it matters.',
        '- Do not assume Discord behavior such as guilds, roles, or Discord threads.',
      ].join('\n')
    case 'discord':
      return [
        '- This conversation runs in Discord. It can cover a channel or a native thread.',
        '- Copy a supplied native mention exactly. Never build one from an ID or name.',
        '- Supported image attachments can arrive on inbound messages. When an `images` entry is present, its `storageReference` is the URL to inspect.',
      ].join('\n')
    default:
      return [
        '- Copy a supplied native mention exactly. Never build one from an ID or name.',
        '- Do not assume files or images are available. When an `images` entry is present, its `storageReference` is the URL to inspect. Otherwise work from message text and say what you could not see when it matters.',
        '- You work in one channel or thread on this platform. Follow the supplied context and do not assume Discord or Slack behavior.',
      ].join('\n')
  }
}

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
    renderChannelAgent: (context) => {
      const platformKind = context.platform ?? context.thread.conversationBinding.platform
      return renderTemplate('channel-agent', templates.channelAgent, {
        platform: platformKind,
        platformContext: renderPlatformContext(platformKind),
        channelName: context.thread.channelContext.name,
        channelDescription: context.thread.channelContext.description || '(No channel description)',
        currentWorkingDirectory: context.thread.workingDirectory,
        modelHint: renderModelHint(context.thread),
        availableAgentModels: renderAvailableModels(context.availableAgentModels),
        identity: context.identityText ?? DefaultIdentityText,
        rootUsers: renderRootUsersSection(context.rootUsers ?? []),
        fridayCliPath: FRIDAY_CLI_PATH,
      })
    },
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
