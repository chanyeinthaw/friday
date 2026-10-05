import type { CliBranchSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'
import { discordConfigCommands } from './Discord.ts'
import { identityConfigCommands } from './Identity.ts'
import { modelConfigCommands } from './Models.ts'
import { optChatConfigCommand } from './OptChat.ts'
import { slackConfigCommands } from './Slack.ts'

export const configCommand: CliBranchSpec = {
  name: 'config',
  summary: "View or change Friday's stored configuration.",
  children: [
    {
      name: 'reload',
      summary: 'Reload the running Friday configuration.',
      parse: Parsing.parseConfigReload,
    },
    optChatConfigCommand,
    ...modelConfigCommands,
    ...identityConfigCommands,
    ...discordConfigCommands,
    ...slackConfigCommands,
  ],
}
