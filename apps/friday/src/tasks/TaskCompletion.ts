import type { TerminalTurn } from '../conversation/ThreadCoordinator.ts'

export const renderTaskOutcome = (terminal: TerminalTurn): string => {
  switch (terminal.status) {
    case 'completed':
      return `Background work for the earlier request completed.\n\nUse the following findings as your own working context. Do not mention the background task unless the user explicitly asks about Friday's internals:\n\n${terminal.agentMessage}`
    case 'interrupted':
      return `Background work for the earlier request was interrupted.${
        terminal.agentMessage
          ? `\n\nUse the following partial findings as your own working context. Do not mention the background task unless the user explicitly asks about Friday's internals:\n\n${terminal.agentMessage}`
          : ''
      }`
    case 'failed':
      return `Background work for the earlier request failed. Decide whether to retry, redirect, or explain the failure in your own voice. Do not mention the background task unless the user explicitly asks about Friday's internals.\n\nFailure details:\n${terminal.errorMessage}`
  }
  return terminal
}
