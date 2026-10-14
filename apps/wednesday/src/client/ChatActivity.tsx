import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Search,
  Terminal,
  TextSearch,
} from 'lucide-react'
import type { ToolActivity } from '../shared/Activity.ts'
import type { ChatMessage } from '../shared/protocol.ts'

const toolPresentation = (activity: ToolActivity) => {
  const running = activity.status === 'running'
  switch (activity.name) {
    case 'web_search':
      return { icon: Search, label: running ? 'Searching the web' : 'Searched the web' }
    case 'bash':
      return { icon: Terminal, label: running ? 'Running a command' : 'Ran a command' }
    case 'zoom':
      return { icon: TextSearch, label: running ? 'Reading memory' : 'Read memory' }
    case 'date':
      return { icon: Clock, label: running ? 'Checking a message date' : 'Checked a message date' }
    default:
      return { icon: TextSearch, label: running ? 'Using a tool' : 'Used a tool' }
  }
}
function ActivityRow({ activity }: { activity: ToolActivity }) {
  const { icon: Icon, label } = toolPresentation(activity)
  const failed = activity.status === 'failed'
  const stopped = activity.status === 'stopped'
  const Status = failed ? CircleX : stopped ? CircleMinus : CircleCheck
  return (
    <details className="group/step min-w-0">
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0">{label}</span>
        {activity.input && (
          <span className="min-w-0 truncate text-xs text-muted-foreground/80">
            {activity.input}
          </span>
        )}
        {activity.status !== 'running' && (
          <Status
            aria-label={failed ? 'Failed' : stopped ? 'Stopped' : 'Completed'}
            className={`ml-auto size-3 shrink-0 ${failed ? 'text-destructive' : ''}`}
          />
        )}
        <ChevronRight className="size-3 shrink-0 group-open/step:rotate-90" />
      </summary>
      <div className="my-2 ml-1.5 space-y-3 border-l border-border pl-4 text-xs leading-relaxed">
        {activity.input && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
            {activity.input}
          </pre>
        )}
        <p className="text-muted-foreground">
          {failed
            ? 'This step failed.'
            : stopped
              ? 'This step was stopped.'
              : activity.status === 'running'
                ? 'In progress…'
                : 'Completed'}
        </p>
        {activity.output && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">
            {activity.output}
          </pre>
        )}
      </div>
    </details>
  )
}

/** Compact disclosures match T3 Code's work log, without continuous animation. */
export function ChatActivity({ messages }: { messages: readonly ChatMessage[] }) {
  const steps = messages.flatMap((message) => (message.activity ? [message.activity] : []))
  const running = steps.findLast((step) => step.status === 'running')
  const latest = running ?? steps.at(-1)
  if (!latest) return null
  if (steps.length === 1)
    return (
      <div className="px-1">
        <ActivityRow activity={latest} />
      </div>
    )
  const { icon: Icon, label } = toolPresentation(latest)
  const failures = steps.filter((step) => step.status === 'failed').length
  const stopped = steps.some((step) => step.status === 'stopped')
  const summary = `${steps.length} steps${failures ? ` · ${failures} failed` : stopped ? ' · Stopped' : ''}`
  return (
    <details className="group/work min-w-0 px-1">
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{running ? label : summary}</span>
        <ChevronRight className="size-3 shrink-0 group-open/work:rotate-90" />
      </summary>
      <div className="mt-1 flex min-w-0 flex-col gap-0 border-l border-border pl-4">
        {steps.map((step) => (
          <ActivityRow key={step.id} activity={step} />
        ))}
      </div>
    </details>
  )
}

export function ResponseActivity({ phase }: { phase: 'thinking' | 'responding' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-6 items-center gap-2 px-1 text-sm text-muted-foreground">
      <Brain className="size-3.5" />
      {phase === 'responding' ? 'Writing response' : 'Thinking'}
    </div>
  )
}
