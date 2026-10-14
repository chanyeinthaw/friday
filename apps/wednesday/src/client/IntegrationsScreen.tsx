import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Flame, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { FirecrawlStatus } from '../shared/Integrations.ts'
import { connectFirecrawl, disconnectFirecrawl, loadFirecrawl } from './State.ts'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'

const number = new Intl.NumberFormat()
function periodEnd(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function IntegrationsScreen() {
  const [status, setStatus] = useState<FirecrawlStatus>()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const request = useRef<AbortController | null>(null)
  const saving = useRef(false)

  const refresh = () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    void loadFirecrawl(controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) setStatus(result)
        },
        () => {
          if (!controller.signal.aborted) setError('Firecrawl could not load. Try again.')
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
  }
  useEffect(() => {
    refresh()
    return () => request.current?.abort()
  }, [])

  const save = () => {
    const key = apiKey.trim()
    if (!key || saving.current) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    saving.current = true
    setBusy(true)
    setError('')
    void connectFirecrawl(key, controller.signal)
      .then(
        (result) => {
          if (controller.signal.aborted) return
          setStatus(result)
          setApiKey('')
          setReplacing(false)
          toast.success('Settings updated')
        },
        (failure) => {
          if (!controller.signal.aborted)
            setError(failure instanceof Error ? failure.message : 'Firecrawl could not connect.')
        },
      )
      .finally(() => {
        saving.current = false
        if (!controller.signal.aborted) setBusy(false)
      })
  }
  const disconnect = () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    void disconnectFirecrawl(controller.signal)
      .then(
        (result) => {
          if (controller.signal.aborted) return
          setStatus(result)
          setApiKey('')
          setReplacing(false)
          toast.success('Firecrawl disconnected')
        },
        () => {
          if (!controller.signal.aborted) setError('Firecrawl could not disconnect. Try again.')
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
  }
  const end = periodEnd(status?.usage?.billingPeriodEnd ?? null)
  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
      <div className="overflow-hidden rounded-2xl border border-border/80">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Flame className="size-4 shrink-0 text-orange-500" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-medium">Firecrawl</h2>
              {status?.connected && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Enabled
                </span>
              )}
            </div>
          </div>
          <Button asChild variant="ghost" size="icon-sm" className="shrink-0 rounded-lg">
            <a
              href="https://www.firecrawl.dev/app/api-keys"
              target="_blank"
              rel="noreferrer"
              aria-label="Open Firecrawl dashboard">
              <ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
        <div className="space-y-3 border-t border-border/70 p-4">
          {!status && !error ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : null}
          {status && (!status.connected || replacing) && (
            <div className="space-y-2">
              <label htmlFor="firecrawl-api-key" className="text-sm font-medium">
                API key
              </label>
              <Input
                id="firecrawl-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="fc-…"
                className="h-9 rounded-lg"
                value={apiKey}
                disabled={busy}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setError('')
                }}
                onBlur={save}
                onPaste={(event) => {
                  const key = event.clipboardData.getData('text').trim()
                  if (key) setTimeout(() => document.getElementById('firecrawl-api-key')?.blur(), 0)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    save()
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {busy ? 'Connecting…' : 'Paste a key to connect.'}
              </p>
              <a
                href="https://www.firecrawl.dev/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
                Get a free API key <ExternalLink className="size-3" />
              </a>
              <p className="text-xs text-muted-foreground">
                1,000 free credits/month · 10 searches/minute.
              </p>
            </div>
          )}
          {status?.connected && (
            <>
              <div className="flex items-center justify-between gap-3">
                {status.usage ? (
                  <div className="space-y-1">
                    <p className="text-sm">
                      <span className="font-medium tabular-nums">
                        {number.format(status.usage.remainingCredits)}
                      </span>
                      <span className="text-muted-foreground">
                        {' '}
                        / {number.format(status.usage.planCredits)} credits remaining
                      </span>
                    </p>
                    {end && <p className="text-xs text-muted-foreground">Period ends {end}</p>}
                  </div>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    {status.usageError ?? 'Usage is unavailable.'}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={refresh}
                  className="rounded-lg text-muted-foreground"
                  aria-label="Refresh Firecrawl usage">
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                2 credits/search · Shared across Firecrawl apps.{' '}
                <a
                  href="https://docs.firecrawl.dev/rate-limits"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4">
                  Rate limits
                </a>
              </p>
              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 rounded-lg text-muted-foreground"
                  disabled={busy}
                  onClick={() => setReplacing((value) => !value)}>
                  {replacing ? 'Cancel' : 'Change API key'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-2 rounded-lg text-muted-foreground"
                  disabled={busy}
                  onClick={disconnect}>
                  Disconnect
                </Button>
              </div>
            </>
          )}
          {error && (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              {!status && (
                <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
                  Retry
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
