import { Schema } from 'effect'
import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUp } from 'lucide-react'
import { sendSignInCode, verifySignInCode } from './State.ts'
import { Button } from './components/ui/button.tsx'
import { Bubble, BubbleContent } from './components/ui/bubble.tsx'
import { Message, MessageContent } from './components/ui/message.tsx'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from './components/ui/message-scroller.tsx'
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from './components/ui/input-group.tsx'

const parseEmail = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
)
interface LoginMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export function LoginScreen() {
  const [messages, setMessages] = useState<readonly LoginMessage[]>([
    { role: 'assistant', text: 'Enter your email to sign in.' },
  ])
  const [email, setEmail] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<'sending' | 'verifying'>('sending')
  const [verified, setVerified] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const layout = useRef<HTMLElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    mounted.current = true
    const node = composer.current
    const measure = () =>
      layout.current?.style.setProperty('--composer-height', `${node?.offsetHeight ?? 120}px`)
    measure()
    const observer = new ResizeObserver(measure)
    if (node) observer.observe(node)
    return () => {
      mounted.current = false
      observer.disconnect()
    }
  }, [])
  const append = (role: LoginMessage['role'], text: string) =>
    setMessages((messages) => [...messages, { role, text }])
  const run = (
    task: Promise<void>,
    success: () => void,
    kind: 'sending' | 'verifying' = 'sending',
  ) => {
    pending.current = true
    setBusy(true)
    setOperation(kind)
    void task
      .then(
        () => {
          if (mounted.current) success()
        },
        (error: Error) => {
          if (mounted.current) append('assistant', error.message || 'Could not sign in. Try again.')
        },
      )
      .finally(() => {
        pending.current = false
        if (mounted.current) {
          setBusy(false)
          input.current?.focus({ preventScroll: true })
        }
      })
  }
  const submit = () => {
    if (pending.current || verified || !draft.trim()) return
    const text = draft.trim()
    setDraft('')
    append('user', email ? '••••••' : text)
    if (!email) {
      const parsed = parseEmail(text)
      if (parsed._tag === 'None') {
        append('assistant', 'Enter a valid email address.')
        return
      }
      run(sendSignInCode(parsed.value), () => {
        setEmail(parsed.value)
        append('assistant', `Thanks! I sent a code to ${parsed.value}. Enter the code below.`)
      })
    } else {
      const code = text.replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) {
        append('assistant', 'Enter the six-digit code from your email.')
        return
      }
      run(
        verifySignInCode(code),
        () => {
          setVerified(true)
          append('assistant', 'You’re signed in.')
        },
        'verifying',
      )
    }
  }
  return (
    <main ref={layout} className="relative flex h-dvh flex-col">
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-5 pb-[calc(var(--composer-height,120px)+2.5rem)] pt-20 sm:px-8">
              {messages.map((message, index) => (
                <MessageScrollerItem key={index} messageId={`login-${index}`}>
                  <Message align={message.role === 'user' ? 'end' : 'start'}>
                    <MessageContent>
                      <Bubble variant={message.role === 'user' ? 'secondary' : 'ghost'}>
                        <BubbleContent>
                          <p className="whitespace-pre-wrap">{message.text}</p>
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <div ref={composer} className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] sm:px-8">
              <div className="flex items-center justify-center gap-2">
                {busy && (
                  <span
                    role="status"
                    className="rounded-full border bg-transparent px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md">
                    {operation === 'verifying' ? 'Checking code…' : 'Sending code…'}
                  </span>
                )}
                <MessageScrollerButton
                  placement="inline"
                  className="pointer-events-auto border border-border bg-transparent backdrop-blur-md"
                />
              </div>
              {email && !verified && (
                <div className="pointer-events-auto flex items-center justify-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (pending.current) return
                      run(sendSignInCode(email), () =>
                        append('assistant', `I sent a new code to ${email}. Enter it below.`),
                      )
                    }}>
                    Send another code
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEmail('')
                      setDraft('')
                      append('assistant', 'Enter your email.')
                      input.current?.focus({ preventScroll: true })
                    }}>
                    Use another email
                  </Button>
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
                    ref={input}
                    rows={1}
                    aria-label={email ? 'Verification code' : 'Email address'}
                    placeholder={email ? 'Enter your code' : 'Enter your email'}
                    autoComplete={email ? 'one-time-code' : 'email'}
                    inputMode={email ? 'numeric' : 'email'}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy || verified}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="min-h-12 max-h-[calc(4lh+1.5rem)] overflow-y-auto px-5 py-3 text-base/6 sm:pt-3.5 sm:pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:text-sm/6"
                    onKeyDown={(event) => {
                      const touch =
                        navigator.maxTouchPoints > 0 ||
                        window.matchMedia('(pointer: coarse)').matches
                      if (
                        !touch &&
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        submit()
                      }
                    }}
                  />
                  <InputGroupAddon align="inline-end" className="self-end p-2 has-[>button]:mr-0">
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      className="rounded-full"
                      aria-label={email ? 'Verify code' : 'Send code'}
                      disabled={busy || verified || !draft.trim()}>
                      <ArrowUp />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
              <div className="pointer-events-auto text-center text-xs text-muted-foreground">
                <Link to="/waitlist" className="rounded-full px-3 py-1.5 hover:text-foreground">
                  Join waitlist
                </Link>
              </div>
            </div>
          </div>
        </MessageScroller>
      </MessageScrollerProvider>
    </main>
  )
}
