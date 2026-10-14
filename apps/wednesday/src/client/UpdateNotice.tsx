import { Effect, Schedule, Schema } from 'effect'
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { buildId, BuildInfo } from '../shared/Build.ts'
import { canReload, saveReloadDraft } from './ReloadDraft.ts'
import { registry, stateAtom } from './State.ts'
import type { Model } from './App.ts'

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(BuildInfo))
export function UpdateNotice({ model }: { model: Model }) {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let checking = false
    const check = Effect.gen(function* () {
      if (document.hidden || checking) return
      checking = true
      yield* Effect.gen(function* () {
        const response = yield* Effect.tryPromise((signal) =>
          fetch('/version', { cache: 'no-store', signal }),
        )
        if (!response.ok) return
        const version = yield* decode(yield* Effect.tryPromise(() => response.text()))
        setAvailable(version.id !== buildId)
      }).pipe(
        Effect.timeout('10 seconds'),
        Effect.ensuring(
          Effect.sync(() => {
            checking = false
          }),
        ),
      )
    }).pipe(Effect.ignore)
    const run = () => {
      void Effect.runPromise(check, { signal: controller.signal }).catch(() => undefined)
    }
    void Effect.runPromise(check.pipe(Effect.repeat(Schedule.spaced('1 minute'))), {
      signal: controller.signal,
    }).catch(() => undefined)
    document.addEventListener('visibilitychange', run)
    window.addEventListener('focus', run)
    window.addEventListener('pageshow', run)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', run)
      window.removeEventListener('focus', run)
      window.removeEventListener('pageshow', run)
    }
  }, [])
  if (!available) return null
  const reload = () => {
    const current = registry.get(stateAtom)
    if (!canReload(current)) return
    void Effect.runPromise(
      saveReloadDraft({
        userId: current.userId,
        revision: current.conversationRevision,
        savedAt: Date.now(),
        draft: current.draft,
        attachments: current.attachments,
        reply: current.reply,
      }).pipe(Effect.tap(() => Effect.sync(() => window.location.reload()))),
    ).catch(() => toast.error('Could not preserve your draft. Please try again.'))
  }
  return (
    <div className="flex justify-center">
      <button
        type="button"
        disabled={!canReload(model)}
        onClick={reload}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border bg-transparent px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-md disabled:opacity-60">
        <RefreshCw className="size-3" />
        <span role="status">Update available</span>
        <span aria-hidden="true">·</span>
        <span>Reload</span>
      </button>
    </div>
  )
}
