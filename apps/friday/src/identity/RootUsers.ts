import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Option from 'effect/Option'

import type { RootUser } from '../config/RootUsers.ts'

export type { RootUser } from '../config/RootUsers.ts'

export interface RootUserScope {
  readonly platform: RootUser['platform']
  readonly scopeId: string
}

/**
 * Derives the root-user scope from a channel binding. Adapters provide the
 * exact guild/workspace ID in `scopeId`; Discord keeps a fallback because its
 * canonical conversation IDs also contain the guild ID. Other platforms and
 * Discord DMs (`@me`) have no guild/workspace scope and yield no root users.
 */
export const rootUserScopeFromBinding = (
  binding: ConversationBinding,
): Option.Option<RootUserScope> => {
  if (binding.platform !== 'discord' && binding.platform !== 'slack') return Option.none()
  if (binding.scopeId !== undefined) {
    return Option.some({ platform: binding.platform, scopeId: String(binding.scopeId) })
  }
  if (binding.platform !== 'discord') return Option.none()
  const parts = String(binding.conversationId).split(':')
  if (parts[0] !== 'discord') return Option.none()
  const scopeId = parts[1] ?? ''
  if (scopeId.length === 0 || scopeId === '@me') return Option.none()
  return Option.some({ platform: 'discord', scopeId })
}

/** Keeps only identities matching both platform and guild/workspace scope. */
export const rootUsersForScope = (
  registry: ReadonlyArray<RootUser>,
  scope: RootUserScope,
): ReadonlyArray<RootUser> =>
  registry.filter(
    (rootUser) => rootUser.platform === scope.platform && rootUser.scopeId === scope.scopeId,
  )

/** Scoped subset for a channel binding; empty when the binding has no scope. */
export const rootUsersForBinding = (
  registry: ReadonlyArray<RootUser>,
  binding: ConversationBinding,
): ReadonlyArray<RootUser> => {
  const scope = rootUserScopeFromBinding(binding)
  return Option.isNone(scope) ? [] : rootUsersForScope(registry, scope.value)
}

const rootUserBullet = (rootUser: RootUser): string =>
  `- Platform \`${rootUser.platform}\`, scope \`${rootUser.scopeId}\`, user \`${rootUser.userId}\``

/**
 * Structured root-user content for the channel-agent system prompt. Returns a
 * stable placeholder when no root user is configured so the template never
 * leaks another scope's identities and the agent asks for clarification.
 */
export const renderRootUsersSection = (rootUsers: ReadonlyArray<RootUser>): string =>
  rootUsers.length === 0
    ? '(No root users are configured for this channel scope.)'
    : rootUsers.map(rootUserBullet).join('\n')
