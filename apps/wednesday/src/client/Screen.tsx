import { UpdateNotice } from './UpdateNotice.tsx'
import { ClearConversation } from './ClearConversation.tsx'
import { ChatActivity, ResponseActivity } from './ChatActivity.tsx'
import { Schema } from 'effect'
import { flushSync } from 'react-dom'
import { Link, Outlet, useNavigate, useLocation } from '@tanstack/react-router'
import { cn } from 'cn'
import { toast } from 'sonner'
import { Toaster } from './components/ui/sonner.tsx'
import { useAtomValue } from '@effect/atom-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Paperclip,
  ArrowUp,
  Check,
  Copy,
  Reply,
  Square,
  Trash2,
  Plus,
  ChevronDown,
  Settings,
  Eye,
  EyeOff,
  ExternalLink,
  X,
} from 'lucide-react'
import { AttachmentItem, UploadTile, MessageAttachments } from './Attachments.tsx'
import { maxAttachments, maxAttachmentSize } from '../shared/Attachments.ts'
import {
  dispatch,
  readyAtom,
  stateAtom,
  registry,
  uploadAttachment,
  cancelUpload,
} from './State.ts'
import { Message as Action } from './Messages.ts'
import {
  ApiFormat,
  Thinking,
  type MessageReply,
  type ChatMessage,
  type PendingMessage,
} from '../shared/protocol.ts'
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
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx'
import { LoginScreen } from './LoginScreen.tsx'
import { ClerkElement } from './ClerkElement.tsx'
import { SettingsLayout } from './SettingsLayout.tsx'
import ChatMarkdown from './markdown/ChatMarkdown.tsx'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'

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
function ReplyPreview({ reply, onCancel }: { reply: MessageReply; onCancel?: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-l-2 border-muted-foreground/30 pl-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-muted-foreground">
          {reply.kind === 'user' ? 'You' : 'Friday'}
        </p>
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">
          {reply.text.replace(/\s+/g, ' ').trim()}
        </p>
      </div>
      {onCancel && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-full"
          aria-label="Cancel reply"
          onClick={onCancel}>
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

function MessageActions({ item }: { item: ChatMessage }) {
  if (item.kind !== 'user' && item.kind !== 'talk') return null
  return (
    <MessageFooter
      className={cn(
        '[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
        item.kind === 'user' && 'justify-end',
      )}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:size-6"
        aria-label={item.kind === 'user' ? 'Reply to your message' : 'Reply to Friday'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (item.kind !== 'user' && item.kind !== 'talk') return
          const input = document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Message"]',
          )
          const selection = input ? ([input.selectionStart, input.selectionEnd] as const) : null
          // WebKit can retain the caret's old layer position when an active input moves.
          input?.blur()
          const reply = { id: item.id, kind: item.kind, text: item.text }
          flushSync(() => dispatch(Action.SelectedReply({ reply })))
          if (!input) return
          // Flush layout before requesting the keyboard, inside the original tap gesture.
          input.getBoundingClientRect()
          input.focus({ preventScroll: true })
          if (selection) input.setSelectionRange(selection[0], selection[1])
        }}>
        <Reply className="size-3.5" />
      </Button>
      {item.kind !== 'user' && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="[@media(hover:hover)_and_(pointer:fine)]:size-6"
          aria-label="Copy message"
          onClick={() => {
            void navigator.clipboard
              .writeText(item.text)
              .catch(() => dispatch(Action.Failed({ message: 'Could not copy this message.' })))
          }}>
          <Copy className="size-3.5" />
        </Button>
      )}
    </MessageFooter>
  )
}

function SubmissionFeedback({ item }: { item: PendingMessage }) {
  if (item.status !== 'failed' && item.status !== 'discarded' && item.status !== 'cancelled')
    return null
  return (
    <MessageFooter className="items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {item.status === 'cancelled'
          ? 'Stopped'
          : item.status === 'discarded'
            ? 'Not delivered'
            : 'Not sent'}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => dispatch(Action.RetriedSubmission({ requestId: item.requestId }))}>
        Send again
      </Button>
    </MessageFooter>
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
  const anchor = useRef<{ element: HTMLElement; viewport: HTMLElement; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor.current || model.loadingHistory) return
    const { element, viewport, top } = anchor.current
    viewport.scrollTop += element.getBoundingClientRect().top - top
    anchor.current = null
  }, [model.messages, model.loadingHistory])
  const timeline = [
    ...model.messages.filter(
      (item) => item.kind === 'user' || item.kind === 'talk' || item.activity,
    ),
    ...model.pendingMessages,
    ...(model.streaming
      ? [{ ...model.streaming, id: -1, streamId: model.streaming.id, kind: 'talk' as const }]
      : []),
  ].toSorted((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  const rows: (ChatMessage | PendingMessage | { activities: ChatMessage[] })[] = []
  for (const item of timeline) {
    if ('id' in item && item.activity) {
      const previous = rows.at(-1)
      if (previous && 'activities' in previous) previous.activities.push(item)
      else rows.push({ activities: [item] })
    } else rows.push(item)
  }
  return (
    <>
      {model.hasOlder && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={model.loadingHistory || model.connection !== 'ready'}
            onClick={(event) => {
              const viewport = event.currentTarget.closest(
                '[data-slot="message-scroller-viewport"]',
              )
              const element = viewport?.querySelector('[data-history-message]')
              if (viewport instanceof HTMLElement && element instanceof HTMLElement)
                anchor.current = { element, viewport, top: element.getBoundingClientRect().top }
              dispatch(Action.LoadOlder())
            }}>
            {model.loadingHistory ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {rows.map((item) => {
        if ('activities' in item) {
          const id = `activity-${item.activities[0]?.id}`
          return (
            <MessageScrollerItem key={id} messageId={id} data-history-message>
              <ChatActivity messages={item.activities} />
            </MessageScrollerItem>
          )
        }
        const stored = 'id' in item
        const user = !stored || item.kind === 'user'
        const key =
          stored && item.streamId
            ? `stream-${item.streamId}`
            : item.requestId
              ? `request-${item.requestId}`
              : stored
                ? `message-${item.id}`
                : ''
        return (
          <MessageScrollerItem key={key} messageId={key} data-history-message>
            <Message align={user ? 'end' : 'start'}>
              <MessageContent className="gap-1">
                <Bubble variant={user ? 'secondary' : 'ghost'}>
                  <BubbleContent>
                    {'reply' in item && item.reply && (
                      <div className="mb-3">
                        <ReplyPreview reply={item.reply} />
                      </div>
                    )}
                    <MessageAttachments
                      files={'attachments' in item ? item.attachments : undefined}
                    />
                    {user ? (
                      <p className="whitespace-pre-wrap">{item.text}</p>
                    ) : (
                      <ChatMarkdown text={item.text} streaming={stored && item.id < 0} />
                    )}
                  </BubbleContent>
                </Bubble>
                {!stored && <SubmissionFeedback item={item} />}
                {stored && item.id >= 0 && <MessageActions item={item} />}
              </MessageContent>
            </Message>
          </MessageScrollerItem>
        )
      })}
    </>
  )
}
const addFiles = (files: readonly File[]) => {
  const model = registry.get(stateAtom)
  if (model.connection !== 'ready' || !model.activeSettings) return
  const available = maxAttachments - model.attachments.length - model.uploading
  if (files.length > available) {
    toast.error('Attach up to 10 files per message.')
    return
  }
  for (const file of files) {
    if (!file.size || file.size > maxAttachmentSize) {
      toast.error('Choose a nonempty file smaller than 10 MB.')
      continue
    }
    uploadAttachment(file)
  }
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
    <main
      ref={layout}
      className="relative flex h-dvh flex-col"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault()
          addFiles(Array.from(event.dataTransfer.files))
        }
      }}>
      <SettingsLink />
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport className="scroll-fade-y">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-5 pb-[calc(var(--composer-height,120px)+2.5rem)] pt-20 sm:px-8">
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
              {model.busy &&
                model.memoryStatus !== 'preparing' &&
                !model.messages.some((item) => item.activity?.status === 'running') && (
                  <MessageScrollerItem messageId="thinking">
                    <ResponseActivity phase={model.responsePhase} />
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
const composerCanSubmit = (model: Model) =>
  (model.draft.trim() || model.attachments.length > 0) &&
  !model.uploading &&
  !!model.activeSettings &&
  model.connection === 'ready' &&
  !model.saving

const composerHasDraft = (model: Model) =>
  model.draft.length > 0 || model.attachments.length > 0 || model.uploading > 0

function Composer({ model }: { model: Model }) {
  const picker = useRef<HTMLInputElement>(null)
  const scrollable = useMessageScrollerScrollable()
  const submit = () => dispatch(Action.Send({ steer: model.busy }))
  const showStop = model.busy && !composerHasDraft(model)
  return (
    <div className="mx-auto w-full max-w-3xl composer-spacing space-y-3 px-4 sm:px-8">
      <div className="pointer-events-auto empty:hidden">
        <Feedback model={model} />
      </div>
      <UpdateNotice model={model} />
      {(model.connection !== 'ready' || model.memoryStatus !== 'idle' || scrollable.end) && (
        <div className="flex items-center justify-center gap-2">
          {model.connection !== 'ready' && (
            <span
              role="status"
              className="pointer-events-auto rounded-full border bg-transparent px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
              {model.connection === 'syncing' ? 'Syncing messages…' : 'Connecting…'}
            </span>
          )}
          {model.memoryStatus !== 'idle' && (
            <span
              role="status"
              className="pointer-events-auto rounded-full border bg-transparent px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
              {model.memoryStatus === 'preparing' ? 'Preparing memory…' : 'Updating memory…'}
            </span>
          )}
          <MessageScrollerButton
            placement="inline"
            className="pointer-events-auto border border-border bg-transparent backdrop-blur-md"
          />
        </div>
      )}
      {model.connection === 'ready' && !model.activeSettings && (
        <div className="pointer-events-auto flex justify-center">
          <Button
            asChild
            variant="outline"
            size="sm"
            className="rounded-full bg-transparent backdrop-blur-md">
            <Link to="/settings">Choose a model</Link>
          </Button>
        </div>
      )}
      <form
        className="pointer-events-auto"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}>
        <div className="relative isolate overflow-hidden rounded-3xl border border-input bg-transparent shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] backdrop-blur-md"
          />
          {(model.attachments.length > 0 || model.uploading > 0) && (
            <div className="flex max-h-[min(16rem,35dvh)] flex-wrap gap-2 overflow-y-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {model.attachments.map((file) => (
                <AttachmentItem
                  key={file.id}
                  file={file}
                  onRemove={() => dispatch(Action.RemovedAttachment({ id: file.id }))}
                />
              ))}
              {model.uploads.map((upload) => (
                <UploadTile
                  key={upload.id}
                  upload={upload}
                  onRemove={() => cancelUpload(upload.id)}
                />
              ))}
            </div>
          )}
          {model.reply && (
            <div className="px-5 pt-4 pb-1">
              <ReplyPreview
                reply={model.reply}
                onCancel={() => dispatch(Action.CancelledReply())}
              />
            </div>
          )}
          <InputGroup
            key="composer-input"
            className="rounded-none border-0 bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
            <InputGroupAddon align="inline-start" className="self-end p-2 has-[>button]:ml-0">
              <input
                ref={picker}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,.txt,.md,.markdown,.html,.htm,.xhtml"
                className="hidden"
                aria-label="Choose attachments"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []))
                  event.target.value = ''
                }}
              />
              <InputGroupButton
                type="button"
                size="icon-sm"
                variant="ghost"
                className="rounded-full"
                aria-label="Attach files"
                disabled={
                  model.connection !== 'ready' ||
                  !model.activeSettings ||
                  model.attachments.length + model.uploading >= maxAttachments
                }
                onClick={() => picker.current?.click()}>
                <Paperclip className="size-4" />
              </InputGroupButton>
            </InputGroupAddon>
            <InputGroupTextarea
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length) {
                  event.preventDefault()
                  addFiles(files)
                }
              }}
              rows={1}
              aria-label="Message"
              placeholder={model.busy ? 'Steer this response…' : 'Message…'}
              value={model.draft}
              onChange={(event) => dispatch(Action.ChangedDraft({ value: event.target.value }))}
              className="min-h-12 max-h-[calc(4lh+1.5rem)] overflow-y-auto pl-1 pr-2 py-3 text-base/6 sm:pt-3.5 sm:pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:text-sm/6"
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
            <InputGroupAddon align="inline-end" className="self-end p-2 has-[>button]:mr-0">
              <div className="ml-auto flex">
                {showStop ? (
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    variant="destructive"
                    className="rounded-full"
                    aria-label="Stop response"
                    onClick={() => dispatch(Action.Stop())}>
                    <Square className="size-2.5 fill-current" />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant="default"
                    className="rounded-full"
                    aria-label={model.busy ? 'Steer response' : 'Send message'}
                    disabled={!composerCanSubmit(model)}>
                    <ArrowUp />
                  </InputGroupButton>
                )}
              </div>
            </InputGroupAddon>
          </InputGroup>
        </div>
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

function SettingsRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6 sm:px-5">
      <div className="min-w-0 lg:flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="w-full min-w-0 lg:w-[22rem] lg:shrink-0">{children}</div>
    </div>
  )
}
function ProviderKeyInput({ model }: { model: Model }) {
  const [showKey, setShowKey] = useState(false)
  return (
    <SettingsRow title="API key">
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
    </SettingsRow>
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
const parseApiFormat = Schema.decodeUnknownOption(ApiFormat)
function ApiProviderSettings({ model }: { model: Model }) {
  return (
    <>
      <SettingsRow title="Message format">
        <Select
          value={model.apiFormat}
          disabled={model.busy || model.fetching || model.saving || model.connection !== 'ready'}
          onValueChange={(value) => {
            const format = parseApiFormat(value)
            if (format._tag === 'Some') dispatch(Action.SelectedApiFormat({ format: format.value }))
          }}>
          <SelectTrigger aria-label="Message format" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat-completions">OpenAI Chat Completions</SelectItem>
            <SelectItem value="responses">OpenAI Responses</SelectItem>
            <SelectItem value="anthropic">Anthropic Messages</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow title="API address">
        <Input
          aria-label="API address"
          type="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={
            model.apiFormat === 'anthropic'
              ? 'https://api.anthropic.com/v1'
              : 'https://api.openai.com/v1'
          }
          value={model.baseUrl}
          onChange={(e) => dispatch(Action.ChangedUrl({ value: e.target.value }))}
        />
      </SettingsRow>
      <ProviderKeyInput model={model} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
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
      className="grid grid-cols-2 gap-2 rounded-[calc(var(--radius-md)+0.25rem)] bg-muted/50 p-1"
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
    <section aria-labelledby="provider-settings">
      <h2 id="provider-settings" className="mb-3 px-4 text-sm text-muted-foreground">
        Provider
      </h2>
      <div className="overflow-hidden rounded-2xl border border-border/80">
        <SettingsRow title="Connection" description={providerName}>
          <ProviderTabs model={model} method={method} setMethod={setMethod} />
        </SettingsRow>
        <div className="border-t border-border/70">
          {method === 'chatgpt' ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
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
                        model.fetching ||
                        model.provider !== 'chatgpt' ||
                        model.connection !== 'ready'
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
            <div className="divide-y divide-border/70">
              <ApiProviderSettings model={model} />
            </div>
          )}
        </div>
      </div>
      <ChatGptSignIn model={model} open={authOpen} setOpen={setAuthOpen} />
    </section>
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
    <SettingsRow
      title={title}
      description={memory ? 'Used to remember earlier messages.' : 'Used for your conversation.'}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-stretch rounded-md border shadow-xs">
          <div className="min-w-0 flex-1">
            <ModelCombobox
              label={title}
              value={memory ? model.memoryModelId || 'Same as chat model' : model.modelId}
              models={memory ? [{ id: 'Same as chat model' }, ...model.models] : model.models}
              disabled={!model.models.length || model.fetching}
              onConfigure={(value) =>
                onConfigure(value === 'Same as chat model' ? model.modelId : value)
              }
              className="rounded-none rounded-l-md border-0 shadow-none"
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
                className="rounded-none rounded-r-md border-0 shadow-none"
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
    </SettingsRow>
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
      <h2 id="chat-preferences" className="mb-3 px-4 text-sm text-muted-foreground">
        Models
      </h2>
      <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border/80">
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
  return (
    <SettingsLayout>
      <div className="space-y-9">
        <ChatPreferences model={model} />
        <ProviderSettings model={model} />
        <ClearConversation busy={model.busy} />
      </div>
      <div className="mt-5">
        <Feedback model={model} />
      </div>
    </SettingsLayout>
  )
}
export function ChatScreen() {
  const model = useAtomValue(stateAtom)
  return <Chat model={model} />
}
export function AppShell() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const model = useAtomValue(stateAtom)
  const ready = useAtomValue(readyAtom)
  const wasSignedOut = useRef(false)
  const saved = useRef(model.settingsSaved)
  useEffect(() => {
    if (model.settingsSaved > saved.current)
      toast.success('Settings updated', { id: 'settings-updated' })
    saved.current = model.settingsSaved
  }, [model.settingsSaved])
  const navigate = useNavigate()
  useEffect(() => {
    if (ready && !model.userId) wasSignedOut.current = true
    if (model.userId && wasSignedOut.current) {
      wasSignedOut.current = false
      dispatch(Action.OpenedPage({ page: 'chat' }))
      void navigate({ to: '/' })
      return
    }
    if (model.userId && model.page === 'settings') {
      dispatch(Action.OpenedPage({ page: 'chat' }))
      void navigate({ to: '/settings' })
    }
  }, [model.userId, model.page, ready, navigate])
  if (!ready)
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
        {model.error || 'Loading…'}
      </div>
    )
  if (!model.userId && pathname !== '/waitlist') return <LoginScreen />
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
