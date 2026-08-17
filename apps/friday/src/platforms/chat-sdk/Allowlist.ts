export interface PlatformAllowlist {
  readonly userIds: ReadonlyArray<string>
  readonly channelIds: ReadonlyArray<string>
}

export const isAllowedByIds = (input: {
  readonly userId: string
  readonly channelId: string
  readonly allowlist: PlatformAllowlist
}): boolean => {
  const { allowlist } = input
  const userAllowed = allowlist.userIds.length === 0 || allowlist.userIds.includes(input.userId)
  const channelAllowed =
    allowlist.channelIds.length === 0 || allowlist.channelIds.includes(input.channelId)
  return userAllowed && channelAllowed
}
