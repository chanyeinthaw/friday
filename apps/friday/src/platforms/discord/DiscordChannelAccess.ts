import type { AccessPolicy } from '../../config/AppConfig.ts'

/**
 * Adapts Friday's channel policy to Chat SDK's `respondToChannelIds` contract.
 * The pinned Discord adapter only reads `length` and calls `includes(channelId)`.
 */
export const discordRespondToChannelIds = (policy: AccessPolicy): Array<string> => {
  if (policy.mode === 'allow') return [...policy.ids]

  return new Proxy([...policy.ids], {
    get: (_target, property, _receiver) => {
      if (property === 'length') return 1
      if (property === 'includes') {
        return (channelId: string) =>
          policy.mode === 'all' ? true : !policy.ids.includes(channelId)
      }
      return undefined
    },
  })
}
