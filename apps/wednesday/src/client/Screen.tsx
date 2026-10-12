import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { toast } from 'sonner'
import { Toaster } from './components/ui/sonner.tsx'
import { useAtomValue } from '@effect/atom-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Square,
  Trash2,
  Plus,
  ChevronDown,
  Settings,
  LogOut,
  Eye,
  EyeOff,
  ExternalLink,
  Bot,
  X,
} from 'lucide-react'
import { dispatch, readyAtom, stateAtom } from './State.ts'
import { Message as Action } from './Messages.ts'
import { Thinking } from '../shared/protocol.ts'
import type { Model } from './App.ts'
import type { ProviderField } from './ProviderFields.ts'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Label } from './components/ui/label.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from './components/ui/input-group.tsx'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
} from './components/ui/command.tsx'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScrollerScrollable,
} from './components/ui/message-scroller.tsx'
import { Message, MessageContent, MessageFooter } from './components/ui/message.tsx'
import { Bubble, BubbleContent } from './components/ui/bubble.tsx'
import { Marker, MarkerContent } from './components/ui/marker.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx'
import { Streamdown } from 'streamdown'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'

function ClerkElement() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = document.createElement('wednesday-auth')
    ref.current?.append(element)
    return () => element.remove()
  }, [])
  return <div ref={ref} />
}
function Choice({
  value,
  onChange,
  children,
  label,
  disabled = false,
  className,
}: {
  className?: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  label: string
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className={cn('w-full', className)}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="grid min-w-0 gap-2">
      <span>{label}</span>
      {children}
    </Label>
  )
}
function Feedback({ model }: { model: Model }) {
  if (!model.error && !model.notice) return null
  return (
    <div
      role={model.error ? 'alert' : 'status'}
      className="flex items-start gap-3 rounded-lg border bg-transparent px-4 py-3 text-sm backdrop-blur-md">
      <p className={model.error ? 'flex-1 text-destructive' : 'flex-1 text-muted-foreground'}>
        {model.error || model.notice}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={() => dispatch(Action.DismissedFeedback())}>
        <X />
      </Button>
    </div>
  )
}
function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 639px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const changed = () => setMobile(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return mobile
}
function ModelCombobox({
  value,
  models,
  onSelect,
  disabled = false,
  label = 'Choose model',
  className,
  onConfigure,
}: {
  className?: string
  value: string
  models: readonly { id: string; displayName?: string }[]
  onSelect: (id: string) => void
  onConfigure?: (id: string) => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const mobile = useMobile()
  const trigger = (
    <Button
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      aria-label={label}
      disabled={disabled}
      className={cn('w-full justify-between font-normal', className)}>
      <span className="min-w-0 flex-1 truncate text-left">
        {models.find((item) => item.id === value)?.displayName || value || label}
      </span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  )
  const options = (
    <Command>
      <CommandInput placeholder="Search models…" />
      <CommandList className="max-h-[55dvh] sm:max-h-72">
        <CommandEmpty>No models found.</CommandEmpty>
        <CommandGroup>
          {models.map((item) => (
            <CommandItem
              key={item.id}
              value={item.id}
              keywords={item.displayName ? [item.displayName] : []}
              onSelect={() => {
                onSelect(item.id)
                setOpen(false)
              }}
              className="rounded-lg px-3 py-2.5">
              <span className="truncate">{item.displayName || item.id}</span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {item.id === value && <Check className="size-4" />}
                {onConfigure && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Configure ${item.displayName || item.id}`}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen(false)
                      onConfigure(item.id)
                    }}>
                    <Settings className="size-4" />
                  </Button>
                )}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
  if (mobile)
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          bottomSheet
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (event.target instanceof HTMLElement) event.target.focus()
          }}
          aria-describedby={undefined}
          tabIndex={-1}
          className="gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          {options}
        </DialogContent>
      </Dialog>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[min(360px,calc(100vw-32px))] p-1.5">
        {options}
      </PopoverContent>
    </Popover>
  )
}
function SettingsLink() {
  return (
    <div className="fixed right-5 top-5 z-10 sm:right-7 sm:top-6">
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="border border-border bg-transparent backdrop-blur-md">
        <Link to="/settings" aria-label="Settings">
          <Settings className="size-5 text-muted-foreground" />
        </Link>
      </Button>
    </div>
  )
}
function ChatTimeline({ model }: { model: Model }) {
  return (
    <>
      {[
        ...model.messages.filter((item) => item.kind === 'user' || item.kind === 'talk'),
        ...model.pendingMessages,
      ]
        .toSorted((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
        .map((item) => {
          const stored = 'id' in item
          const user = !stored || item.kind === 'user'
          const key = item.requestId
            ? `request-${item.requestId}`
            : stored
              ? `message-${item.id}`
              : ''
          return (
            <MessageScrollerItem key={key} messageId={key}>
              <Message align={user ? 'end' : 'start'}>
                <MessageContent>
                  <Bubble variant={user ? 'secondary' : 'ghost'}>
                    <BubbleContent>
                      {user ? (
                        <p className="whitespace-pre-wrap">{item.text}</p>
                      ) : (
                        <Streamdown>{item.text}</Streamdown>
                      )}
                    </BubbleContent>
                  </Bubble>
                  {!stored && (item.status === 'failed' || item.status === 'discarded') && (
                    <MessageFooter className="items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {item.status === 'discarded' ? 'Not used' : 'Not sent'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          dispatch(Action.RetriedSubmission({ requestId: item.requestId }))
                        }>
                        Edit
                      </Button>
                    </MessageFooter>
                  )}
                  {stored && !user && (
                    <MessageFooter>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Copy message"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(item.text)
                            .catch(() =>
                              dispatch(Action.Failed({ message: 'Could not copy this message.' })),
                            )
                        }}>
                        <Copy className="size-3.5" />
                      </Button>
                    </MessageFooter>
                  )}
                </MessageContent>
              </Message>
            </MessageScrollerItem>
          )
        })}
    </>
  )
}
function Chat({ model }: { model: Model }) {
  const layout = useRef<HTMLElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = composer.current
    if (!node) return
    const measure = () =>
      layout.current?.style.setProperty('--composer-height', `${node.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <main ref={layout} className="relative flex h-dvh flex-col">
      <SettingsLink />
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-5 pb-[calc(var(--composer-height,120px)+2.5rem)] pt-20 sm:px-8">
              {model.connection === 'ready' &&
                model.messages.length === 0 &&
                model.pendingMessages.length === 0 && (
                  <MessageScrollerItem
                    messageId="empty"
                    className="flex flex-1 items-center justify-center py-24">
                    <h1 className="text-2xl font-medium tracking-tight">What’s on your mind?</h1>
                  </MessageScrollerItem>
                )}
              <ChatTimeline model={model} />
              {model.busy && (
                <MessageScrollerItem messageId="thinking">
                  <Marker
                    role="status"
                    className="w-fit rounded-full border bg-transparent px-3 py-1.5 backdrop-blur-md">
                    <MarkerContent>Thinking…</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <div ref={composer} className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <Composer model={model} />
          </div>
        </MessageScroller>
      </MessageScrollerProvider>
    </main>
  )
}
function Composer({ model }: { model: Model }) {
  const scrollable = useMessageScrollerScrollable()
  const submit = () => dispatch(Action.Send({ steer: model.busy }))
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-4 sm:px-8 sm:pb-6">
      <div className="pointer-events-auto empty:hidden">
        <Feedback model={model} />
      </div>
      {(model.connection !== 'ready' || scrollable.end) && (
        <div className="flex items-center justify-center gap-2">
          {model.connection !== 'ready' && (
            <span
              role="status"
              className="pointer-events-auto rounded-full border bg-transparent px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
              {model.connection === 'syncing' ? 'Syncing messages…' : 'Connecting…'}
            </span>
          )}
          <MessageScrollerButton
            placement="inline"
            className="pointer-events-auto border border-border bg-transparent backdrop-blur-md"
          />
        </div>
      )}
      <form
        className="pointer-events-auto"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}>
        <InputGroup className="rounded-3xl bg-transparent shadow-sm backdrop-blur-md">
          <InputGroupTextarea
            rows={2}
            aria-label="Message"
            placeholder={model.busy ? 'Steer this response…' : 'Message…'}
            value={model.draft}
            onChange={(event) => dispatch(Action.ChangedDraft({ value: event.target.value }))}
            className="min-h-[calc(2lh+1.5rem)] max-h-[calc(4lh+1.5rem)] overflow-y-auto px-5 py-3 text-base [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:text-sm"
            onKeyDown={(event) => {
              const touchDevice =
                navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches
              if (touchDevice) return
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <InputGroupAddon align="inline-end" className="self-end p-2">
            <div className="ml-auto flex gap-2">
              {model.busy && (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  className="rounded-full"
                  aria-label="Stop response"
                  onClick={() => dispatch(Action.Stop())}>
                  <Square className="size-3.5" />
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                className="rounded-full"
                aria-label={model.busy ? 'Steer response' : 'Send message'}
                disabled={
                  !model.draft.trim() ||
                  !model.activeSettings ||
                  model.connection !== 'ready' ||
                  model.saving
                }>
                <ArrowUp />
              </InputGroupButton>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}
function ProviderFields({
  rows,
  target,
  parentId = null,
}: {
  rows: readonly ProviderField[]
  target: string
  parentId?: number | null
}) {
  return (
    <div className="space-y-3">
      {rows
        .filter((row) => row.parentId === parentId)
        .map((row) => (
          <div key={row.id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Setting name"
                placeholder="Setting name"
                className="min-w-24 flex-1"
                value={row.name}
                onChange={(e) =>
                  dispatch(
                    Action.ChangedProviderField({
                      target,
                      id: row.id,
                      field: 'name',
                      value: e.target.value,
                    }),
                  )
                }
              />
              <div className="w-28">
                <Choice
                  label="Value type"
                  value={row.kind}
                  onChange={(value) =>
                    dispatch(
                      Action.ChangedProviderField({ target, id: row.id, field: 'kind', value }),
                    )
                  }>
                  {['text', 'number', 'boolean', 'group', 'list', 'empty'].map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind === 'empty' ? 'None' : kind}
                    </SelectItem>
                  ))}
                </Choice>
              </div>
              {row.kind !== 'group' &&
                row.kind !== 'list' &&
                row.kind !== 'empty' &&
                (row.kind === 'boolean' ? (
                  <Checkbox
                    aria-label="Enabled"
                    checked={row.value === 'true'}
                    onCheckedChange={(checked) =>
                      dispatch(
                        Action.ChangedProviderField({
                          target,
                          id: row.id,
                          field: 'value',
                          value: checked === true ? 'true' : 'false',
                        }),
                      )
                    }
                  />
                ) : (
                  <Input
                    aria-label="Setting value"
                    placeholder="Value"
                    className="min-w-24 flex-1"
                    type={row.kind === 'number' ? 'number' : 'text'}
                    value={row.value}
                    onChange={(e) =>
                      dispatch(
                        Action.ChangedProviderField({
                          target,
                          id: row.id,
                          field: 'value',
                          value: e.target.value,
                        }),
                      )
                    }
                  />
                ))}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove setting"
                onClick={() => dispatch(Action.RemovedProviderField({ target, id: row.id }))}>
                <Trash2 />
              </Button>
            </div>
            {(row.kind === 'group' || row.kind === 'list') && (
              <div className="border-l pl-4">
                <ProviderFields rows={rows} target={target} parentId={row.id} />
              </div>
            )}
          </div>
        ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => dispatch(Action.AddedProviderField({ target, parentId }))}>
        <Plus />
        Add setting
      </Button>
    </div>
  )
}
function ModelEditor({ model }: { model: Model }) {
  const [level, setLevel] = useState<Thinking>('off')
  const row = model.editingLevels.find((item) => item.level === level)
  return (
    <div className="space-y-6">
      <div className="space-y-6">
        <Field label="Model name">
          <Input
            value={model.editingId}
            onChange={(e) =>
              dispatch(Action.ChangedMapping({ field: 'id', value: e.target.value }))
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              { label: 'Context window', field: 'context', value: model.editingContext },
              { label: 'Response limit', field: 'output', value: model.editingOutput },
            ] as const
          ).map((item) => (
            <Field key={item.field} label={item.label}>
              <Input
                type="number"
                min="1"
                value={item.value}
                onChange={(e) =>
                  dispatch(Action.ChangedMapping({ field: item.field, value: e.target.value }))
                }
              />
            </Field>
          ))}
        </div>
        <div className="space-y-3">
          <Label>Supported thinking levels</Label>
          <div className="flex flex-wrap gap-2">
            {model.editingLevels.map((item) => (
              <label
                key={item.level}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <Checkbox
                  checked={item.enabled}
                  disabled={item.level === 'off'}
                  onCheckedChange={(checked) =>
                    dispatch(
                      Action.ToggledThinkingLevel({ level: item.level, enabled: checked === true }),
                    )
                  }
                />
                {thinkingLabels[item.level]}
              </label>
            ))}
          </div>
        </div>
        <details className="border-t pt-5">
          <summary className="cursor-pointer text-sm font-medium">Provider options</summary>
          <div className="space-y-6 pt-5">
            <div className="space-y-3">
              <Label>Model request settings</Label>
              <ProviderFields rows={model.editingFields} target="extra" />
            </div>
            <div className="space-y-3">
              <Field label="Thinking level to configure">
                <Choice
                  label="Thinking level to configure"
                  value={level}
                  onChange={(value) => {
                    const next = Thinking.literals.find((item) => item === value)
                    if (next) setLevel(next)
                  }}>
                  {Thinking.literals.map((item) => (
                    <SelectItem key={item} value={item}>
                      {thinkingLabels[item]}
                    </SelectItem>
                  ))}
                </Choice>
              </Field>
              {row && <ProviderFields rows={row.fields} target={level} />}
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
const thinkingLabels = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Maximum',
} satisfies Record<Thinking, string>

function ProviderKeyInput({ model }: { model: Model }) {
  const [showKey, setShowKey] = useState(false)
  return (
    <Field label="API key">
      <div className="relative">
        <Input
          aria-label="API key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className="pr-11"
          placeholder={
            model.hasApiKey ? 'Saved key · leave blank to keep it' : 'Enter your API key'
          }
          value={model.apiKey}
          onChange={(e) => dispatch(Action.ChangedKey({ value: e.target.value }))}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-0.5"
          aria-label={showKey ? 'Hide API key' : 'Show API key'}
          aria-pressed={showKey}
          onClick={() => setShowKey(!showKey)}>
          {showKey ? <EyeOff /> : <Eye />}
        </Button>
      </div>
    </Field>
  )
}
function ChatGptSignIn({
  model,
  open,
  setOpen,
}: {
  model: Model
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const authorization = model.deviceAuthorization
  useEffect(() => {
    if (!open || !authorization || model.deviceLoading || model.deviceError) return
    const timer = window.setTimeout(
      () => dispatch(Action.PollChatGpt()),
      authorization.intervalSeconds * 1000,
    )
    return () => window.clearTimeout(timer)
  }, [open, authorization, model.deviceLoading, model.deviceError])
  useEffect(() => {
    if (!open && authorization) dispatch(Action.CancelChatGpt())
    if (
      open &&
      model.provider === 'chatgpt' &&
      model.hasApiKey &&
      !authorization &&
      !model.deviceLoading
    )
      setOpen(false)
  }, [open, authorization, model.provider, model.hasApiKey, model.deviceLoading, setOpen])
  const close = (next: boolean) => {
    setOpen(next)
    if (!next) dispatch(Action.CancelChatGpt())
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        bottomSheet
        aria-describedby={undefined}
        className="gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <DialogHeader>
          <DialogTitle>Sign in with ChatGPT</DialogTitle>
        </DialogHeader>
        {authorization ? (
          <>
            <a
              href={authorization.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium hover:bg-muted">
              Open ChatGPT <ExternalLink className="size-4" />
            </a>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Enter this code</p>
              <div className="flex items-center justify-between gap-3 rounded-2xl border bg-muted/30 p-4">
                <code className="text-xl font-semibold tracking-widest sm:text-2xl">
                  {authorization.userCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(authorization.userCode).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }}>
                  <Copy className="size-4" />
                  {copied ? 'Copied' : 'Copy code'}
                </Button>
              </div>
            </div>
            {!model.deviceError && (
              <span
                role="status"
                className="mx-auto w-fit rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
                Waiting for approval
              </span>
            )}
          </>
        ) : model.deviceLoading ? (
          <span
            role="status"
            className="mx-auto w-fit rounded-full border px-3 py-1.5 text-xs text-muted-foreground">
            Getting your code…
          </span>
        ) : null}
        {model.deviceError && (
          <p role="alert" className="text-sm text-destructive">
            {model.deviceError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          {model.deviceError && (
            <Button
              disabled={model.deviceLoading}
              onClick={() => {
                setCopied(false)
                dispatch(Action.StartChatGpt())
              }}>
              Get a new code
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
function ApiProviderSettings({ model }: { model: Model }) {
  return (
    <>
      <Field label="API address">
        <Input
          type="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://api.openai.com/v1"
          value={model.baseUrl}
          onChange={(e) => dispatch(Action.ChangedUrl({ value: e.target.value }))}
        />
      </Field>
      <ProviderKeyInput model={model} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {model.models.length
            ? `${model.models.length} models available`
            : 'Find models to get started'}
        </span>
        <Button
          variant={model.models.length ? 'outline' : 'default'}
          disabled={
            !model.baseUrl ||
            (!model.hasApiKey && !model.apiKey) ||
            model.fetching ||
            model.busy ||
            model.connection !== 'ready'
          }
          onClick={() => dispatch(Action.Discover())}>
          {model.fetching
            ? 'Finding models…'
            : model.models.length
              ? 'Refresh models'
              : 'Find models'}
        </Button>
      </div>
    </>
  )
}
function ProviderTabs({
  model,
  method,
  setMethod,
}: {
  model: Model
  method: Model['provider']
  setMethod: (method: Model['provider']) => void
}) {
  const signedIn = model.activeSettings?.provider === 'chatgpt'
  const disabled = model.saving || model.fetching || model.deviceLoading
  return (
    <div
      className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-1"
      role="group"
      aria-label="Provider type">
      <Button
        variant={method === 'chatgpt' ? 'outline' : 'ghost'}
        className="w-full"
        aria-pressed={method === 'chatgpt'}
        disabled={disabled}
        onClick={() => {
          setMethod('chatgpt')
          if (signedIn && model.provider !== 'chatgpt')
            dispatch(Action.SelectedProvider({ provider: 'chatgpt' }))
        }}>
        ChatGPT
      </Button>
      <Button
        variant={method === 'api' ? 'outline' : 'ghost'}
        className="w-full"
        aria-pressed={method === 'api'}
        disabled={disabled}
        onClick={() => {
          setMethod('api')
          if (model.provider !== 'api') dispatch(Action.SelectedProvider({ provider: 'api' }))
        }}>
        API key
      </Button>
    </div>
  )
}
function ProviderSettings({ model }: { model: Model }) {
  const [method, setMethod] = useState<'api' | 'chatgpt'>(model.provider)
  const [authOpen, setAuthOpen] = useState(false)
  const refreshedAccount = useRef<string | null>(null)
  useEffect(() => {
    if (
      model.provider !== 'chatgpt' ||
      !model.hasApiKey ||
      model.connection !== 'ready' ||
      model.fetching
    )
      return
    if (refreshedAccount.current === model.userId) return
    refreshedAccount.current = model.userId
    dispatch(Action.Discover())
  }, [model.provider, model.hasApiKey, model.connection, model.fetching, model.userId])
  useEffect(() => setMethod(model.provider), [model.provider])
  const provider = model.activeSettings?.baseUrl ?? ''
  const signedIn = model.activeSettings?.provider === 'chatgpt'
  const providerName =
    model.activeSettings?.provider === 'chatgpt'
      ? 'ChatGPT'
      : URL.canParse(provider)
        ? new URL(provider).hostname
        : 'Add a provider'
  return (
    <details
      key={model.userId}
      open={model.activeSettings ? undefined : true}
      className="group/provider rounded-2xl border">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-5 [&::-webkit-details-marker]:hidden sm:p-6">
        <Bot className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">Provider</h2>
          <p className="mt-1 truncate text-sm text-muted-foreground">{providerName}</p>
        </div>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground group-open/provider:rotate-180" />
      </summary>
      <div className="space-y-5 border-t p-5 sm:p-6">
        <ProviderTabs model={model} method={method} setMethod={setMethod} />
        {method === 'chatgpt' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {signedIn ? (
              <>
                <span className="inline-flex items-center gap-2 text-sm">
                  <Check className="size-4" />
                  Signed in
                </span>
                <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
                  <Button
                    variant="outline"
                    disabled={
                      model.fetching || model.provider !== 'chatgpt' || model.connection !== 'ready'
                    }
                    onClick={() => dispatch(Action.Discover())}>
                    {model.fetching ? 'Finding models…' : 'Refresh models'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={model.busy || model.deviceLoading || model.connection !== 'ready'}
                    onClick={() => dispatch(Action.DisconnectChatGpt())}>
                    Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <Button
                className="w-full"
                disabled={model.busy || model.deviceLoading || model.connection !== 'ready'}
                onClick={() => {
                  setAuthOpen(true)
                  dispatch(Action.StartChatGpt())
                }}>
                Sign in with ChatGPT
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <ApiProviderSettings model={model} />
          </div>
        )}
      </div>
      <ChatGptSignIn model={model} open={authOpen} setOpen={setAuthOpen} />
    </details>
  )
}
function ModelPreference({
  model,
  memory = false,
  onConfigure,
}: {
  model: Model
  memory?: boolean
  onConfigure: (id: string) => void
}) {
  const id = memory ? model.memoryModelId || model.modelId : model.modelId
  const selected = model.models.find((item) => item.id === id)
  const levels = Thinking.literals.filter((level) => selected?.thinking[level] !== undefined)
  const title = memory ? 'Memory model' : 'Chat model'
  return (
    <Field label={title}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-stretch rounded-xl border shadow-xs">
          <div className="min-w-0 flex-1">
            <ModelCombobox
              label={title}
              value={memory ? model.memoryModelId || 'Same as chat model' : model.modelId}
              models={memory ? [{ id: 'Same as chat model' }, ...model.models] : model.models}
              disabled={!model.models.length || model.fetching}
              onConfigure={(value) =>
                onConfigure(value === 'Same as chat model' ? model.modelId : value)
              }
              className="rounded-none rounded-l-xl border-0 shadow-none"
              onSelect={(value) =>
                memory
                  ? dispatch(
                      Action.SelectedMemoryModel({
                        id: value === 'Same as chat model' ? '' : value,
                      }),
                    )
                  : dispatch(Action.SelectedModel({ id: value }))
              }
            />
          </div>
          {levels.length > 0 && (
            <div className="w-28 shrink-0 border-l sm:w-32">
              <Choice
                label={memory ? 'Memory thinking effort' : 'Chat thinking effort'}
                disabled={levels.length < 2}
                value={memory ? model.memoryThinking : model.thinking}
                className="rounded-none rounded-r-xl border-0 shadow-none"
                onChange={(value) =>
                  dispatch(
                    memory
                      ? Action.SelectedMemoryThinking({ value })
                      : Action.SelectedThinking({ value }),
                  )
                }>
                {levels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {thinkingLabels[level]}
                  </SelectItem>
                ))}
              </Choice>
            </div>
          )}
        </div>
      </div>
    </Field>
  )
}
function ChatPreferences({ model }: { model: Model }) {
  const [editing, setEditing] = useState(false)
  const configure = (id: string) => {
    dispatch(Action.SelectedMapping({ id }))
    setEditing(true)
  }
  return (
    <section aria-labelledby="chat-preferences">
      <h2 id="chat-preferences" className="mb-3 px-1 text-base font-medium">
        Models
      </h2>
      <div className="space-y-5 rounded-2xl border p-5 sm:p-6">
        <ModelPreference model={model} onConfigure={configure} />
        <ModelPreference model={model} memory onConfigure={configure} />
      </div>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent
          bottomSheet
          aria-describedby={undefined}
          className="flex max-h-[90dvh] flex-col gap-5 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Model settings</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1">
            <ModelEditor model={model} />
            <div className="mt-5">
              <Feedback model={model} />
            </div>
          </div>
          <div className="flex justify-end border-t pt-4 pb-[env(safe-area-inset-bottom)]">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
export function SettingsScreen() {
  const model = useAtomValue(stateAtom)
  const navigate = useNavigate()
  const back = () => {
    dispatch(Action.OpenedPage({ page: 'chat' }))
    void navigate({ to: '/' })
  }
  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto max-w-2xl px-5 pb-12 pt-8 sm:px-8 sm:pt-12">
        <div className="mb-8 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="border border-border bg-transparent backdrop-blur-md"
            aria-label="Back to chat"
            onClick={back}>
            <ArrowLeft />
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>
        <div className="space-y-5">
          <ProviderSettings model={model} />
          <ChatPreferences model={model} />

          <Feedback model={model} />
        </div>
        <div className="mt-8 flex items-center justify-between border-t pt-5">
          <span className="text-sm text-muted-foreground">Account</span>
          <Button variant="ghost" size="sm" onClick={() => dispatch(Action.SignOut())}>
            <LogOut /> Sign out
          </Button>
        </div>
      </div>
    </main>
  )
}
export function ChatScreen() {
  const model = useAtomValue(stateAtom)
  return <Chat model={model} />
}
export function AppShell() {
  const model = useAtomValue(stateAtom)
  const ready = useAtomValue(readyAtom)
  const saved = useRef(model.settingsSaved)
  useEffect(() => {
    if (model.settingsSaved > saved.current)
      toast.success('Settings updated', { id: 'settings-updated' })
    saved.current = model.settingsSaved
  }, [model.settingsSaved])
  const navigate = useNavigate()
  useEffect(() => {
    if (model.userId && model.page === 'settings') {
      dispatch(Action.OpenedPage({ page: 'chat' }))
      void navigate({ to: '/settings' })
    }
  }, [model.userId, model.page, navigate])
  if (!ready)
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
        {model.error || 'Loading…'}
      </div>
    )
  if (!model.userId)
    return (
      <main className="flex min-h-dvh items-center justify-center px-4 py-12">
        <ClerkElement />
      </main>
    )
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  )
}
