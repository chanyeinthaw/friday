export interface AccessPolicy {
  readonly mode: 'all' | 'allow' | 'deny'
  readonly ids: ReadonlyArray<string>
}

export const isAllowedByPolicy = (id: string, policy: AccessPolicy): boolean => {
  switch (policy.mode) {
    case 'all':
      return true
    case 'allow':
      return policy.ids.includes(id)
    case 'deny':
      return !policy.ids.includes(id)
  }
}

export function isAllowedByAccess(input: {
  readonly userId: string
  readonly channelId: string
  readonly userPolicy: AccessPolicy
  readonly channelPolicy: AccessPolicy
}): boolean {
  return (
    isAllowedByPolicy(input.userId, input.userPolicy) &&
    isAllowedByPolicy(input.channelId, input.channelPolicy)
  )
}
