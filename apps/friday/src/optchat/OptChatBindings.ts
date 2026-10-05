import type { AppConfig, OptChatBinding } from '../config/AppConfig.ts'

export const findOptChatBinding = (
  bindings: AppConfig['agent']['optChats'],
  location: {
    readonly platform: string
    readonly connectionId: string
    readonly channelId: string
  },
): OptChatBinding | undefined =>
  bindings?.find(
    (binding) =>
      binding.platform === location.platform &&
      binding.connectionId === location.connectionId &&
      binding.channelId === nativeOptChatChannelId(location.channelId),
  )

/** Adapters qualify channel IDs with platform and scope; configuration uses the native channel ID. */
export const nativeOptChatChannelId = (channelId: string): string =>
  channelId.split(':').at(-1) ?? channelId
