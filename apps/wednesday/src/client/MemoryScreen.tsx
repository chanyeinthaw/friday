import { useAtomValue } from '@effect/atom-react'
import { ArrowUpRight, ChevronRight, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MemoryRange, MemorySnapshot, MemoryTile } from '../shared/Memory.ts'
import { memoryRanges } from '../shared/Memory.ts'
import type { ChatMessage } from '../shared/protocol.ts'
import { browseMemory, readMemoryOriginal, stateAtom } from './State.ts'
import { Button } from './components/ui/button.tsx'
import ChatMarkdown from './markdown/ChatMarkdown.tsx'

const rangeLabel = ({ id, count }: MemoryRange) =>
  count === 1 ? `Message ${id + 1}` : `Messages ${id + 1}–${id + count}`
const key = ({ id, count }: MemoryRange) => `${id}:${count}`
const author = { user: 'You', talk: 'Friday', tool: 'Tool', echo: 'Agent context' }
type Box = { left: number; top: number; width: number; height: number }

/** Preserve chronological order and keep small ranges large enough to select. */
function layout(
  tiles: readonly MemoryTile[],
  box: Box,
  horizontal = true,
): { tile: MemoryTile; box: Box }[] {
  if (tiles.length <= 1) return tiles.map((tile) => ({ tile, box }))
  const total = tiles.reduce((sum, tile) => sum + tile.count, 0)
  const weights = tiles.map((tile) => Math.max(tile.count, total / 24))
  const weight = weights.reduce((sum, value) => sum + value, 0)
  let cut = 1
  let before = weights[0] ?? 0
  while (
    cut < tiles.length - 1 &&
    Math.abs(before + (weights[cut] ?? 0) - weight / 2) < Math.abs(before - weight / 2)
  ) {
    before += weights[cut] ?? 0
    cut++
  }
  const ratio = before / weight
  return [
    ...layout(
      tiles.slice(0, cut),
      horizontal ? { ...box, width: box.width * ratio } : { ...box, height: box.height * ratio },
      !horizontal,
    ),
    ...layout(
      tiles.slice(cut),
      horizontal
        ? { ...box, left: box.left + box.width * ratio, width: box.width * (1 - ratio) }
        : { ...box, top: box.top + box.height * ratio, height: box.height * (1 - ratio) },
      !horizontal,
    ),
  ]
}

function Original({ id }: { id: number }) {
  const [result, setResult] = useState<{ message: ChatMessage | null; error: boolean }>()
  useEffect(() => {
    const abort = new AbortController()
    void readMemoryOriginal(id, abort.signal).then(
      (message) => {
        if (!abort.signal.aborted) setResult({ message, error: false })
      },
      () => {
        if (!abort.signal.aborted) setResult({ message: null, error: true })
      },
    )
    return () => abort.abort()
  }, [id])
  if (!result)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading original…
      </p>
    )
  if (!result.message)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {result.error ? 'The original could not load.' : 'Original unavailable.'}
      </p>
    )
  const message = result.message
  return (
    <div className="space-y-4 border-t pt-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{author[message.kind]}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={message.date}>
          {new Date(message.date).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
      </div>
      {message.kind === 'tool' || message.kind === 'echo' ? (
        <p className="max-h-[32rem] overflow-auto text-sm leading-7 whitespace-pre-wrap wrap-anywhere">
          {message.text}
        </p>
      ) : (
        <ChatMarkdown text={message.text} />
      )}
    </div>
  )
}

function useMemorySnapshot(scope: MemoryRange | undefined, detail: number, refresh: number) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>()
  const [selected, setSelected] = useState<MemoryTile>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const start = scope?.id
  const end = scope ? scope.id + scope.count : undefined
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setError(false)
    void browseMemory(
      start === undefined || end === undefined ? { detail } : { start, end, detail },
      abort.signal,
    ).then(
      (result) => {
        if (abort.signal.aborted) return
        setSnapshot(result)
        setSelected(
          (previous) =>
            result.tiles.find((tile) => previous && key(tile) === key(previous)) ?? result.tiles[0],
        )
        setLoading(false)
      },
      () => {
        if (!abort.signal.aborted) {
          setError(true)
          setLoading(false)
        }
      },
    )
    return () => abort.abort()
  }, [start, end, detail, refresh])
  return { snapshot, selected, setSelected, loading, error }
}

function MemoryOverview({
  total,
  scope,
  navigate,
}: {
  total: number
  scope: MemoryRange | undefined
  navigate: (path: readonly MemoryRange[]) => void
}) {
  return (
    <div className="memory-overview">
      <nav className="flex h-4 gap-1" aria-label="All message ranges">
        {memoryRanges(0, total, 1).map((part) => (
          <button
            type="button"
            key={key(part)}
            aria-label={`Explore ${rangeLabel(part).toLowerCase()}`}
            title={rangeLabel(part)}
            aria-current={
              scope && part.id < scope.id + scope.count && part.id + part.count > scope.id
                ? 'location'
                : undefined
            }
            onClick={() => navigate([part])}
            className="min-w-1 rounded-[4px] border border-[#e1e9e3] bg-[#f0f5f1] hover:bg-[#c4d7c9] focus-visible:outline-ring aria-[current]:border-[#9bb8a4] aria-[current]:bg-[#adc7b5]"
            style={{ flexGrow: part.count + total / 20, flexBasis: 0 }}
          />
        ))}
      </nav>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>First message</span>
        <span>Latest</span>
      </div>
    </div>
  )
}

function MemoryInspector({
  selected,
  close,
  explore,
}: {
  selected: MemoryTile
  close: () => void
  explore: () => void
}) {
  const [original, setOriginal] = useState(false)
  return (
    <section className="memory-inspector" aria-label="Selected memory">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{rangeLabel(selected)}</span>
          <span>{selected.count === 1 ? 'Message summary' : 'Summary'}</span>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close summary" onClick={close}>
          <X className="size-4" />
        </Button>
      </div>
      <p className="memory-summary">{selected.text ?? 'Summary not ready'}</p>
      {selected.count > 1 ? (
        <Button variant="outline" size="sm" onClick={explore}>
          Explore this area
          <ArrowUpRight className="size-3.5" />
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          aria-expanded={original}
          onClick={() => setOriginal((value) => !value)}>
          {original ? 'Hide original' : 'Read original'}
        </Button>
      )}
      {original && selected.count === 1 && <Original key={selected.id} id={selected.id} />}
    </section>
  )
}

function memoryStatus(snapshot: MemorySnapshot | undefined, loading: boolean, error: boolean) {
  if (loading) return 'Loading memories…'
  if (error) return 'Memories could not load.'
  if (!snapshot?.total) return 'No memories yet'
  return rangeLabel({ id: snapshot.start, count: snapshot.end - snapshot.start })
}

function MemoryBrowser() {
  const [path, setPath] = useState<readonly MemoryRange[]>([])
  const [detail, setDetail] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const scope = path.at(-1)
  const { snapshot, selected, setSelected, loading, error } = useMemorySnapshot(
    scope,
    detail,
    refresh,
  )
  const navigate = (next: readonly MemoryRange[]) => {
    setPath(next)
    setDetail(0)
    setSelected(undefined)
  }
  const total = snapshot?.total ?? 0
  const tiles = snapshot?.tiles ?? []
  const height = 300
  const positions = layout(tiles, { left: 0, top: 0, width: 720, height })
  return (
    <section className="memory-browser" aria-label="Memory browser">
      <div className="memory-heading flex items-center justify-between gap-4">
        <nav
          aria-label="Memory range"
          className="memory-breadcrumbs flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-2 text-xs">
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring"
            aria-current={!path.length ? 'page' : undefined}
            onClick={() => navigate([])}>
            All messages
          </button>
          {path.map((part, index) => (
            <span key={key(part)} className="flex items-center gap-2">
              <ChevronRight className="size-3 text-muted-foreground/60" />
              <button
                type="button"
                className="rounded-sm hover:text-foreground focus-visible:outline-ring"
                aria-current={index === path.length - 1 ? 'page' : undefined}
                onClick={() => navigate(path.slice(0, index + 1))}>
                {rangeLabel(part)}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-3">
          {snapshot && (
            <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
              {total.toLocaleString()} messages
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh memories"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      <div className="memory-toolbar flex flex-wrap items-center justify-between gap-4">
        <span role="status" className="text-xs text-muted-foreground">
          {memoryStatus(snapshot, loading, error)}
        </span>
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>Overview</span>
          <input
            type="range"
            aria-label="Memory detail"
            aria-valuetext={['Overview', 'More detail', 'Fine detail', 'Most detail'][detail]}
            min={0}
            max={3}
            step={1}
            value={detail}
            disabled={!total || (scope?.count ?? total) <= 4}
            onChange={(event) => {
              setDetail(Number(event.target.value))
            }}
            className="memory-detail-slider disabled:opacity-40"
          />
          <span>Detail</span>
        </label>
      </div>
      {error && (
        <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
          Try again
        </Button>
      )}
      {snapshot && !total && !error && (
        <div className="rounded-2xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
          Your conversation will appear here.
        </div>
      )}
      {!!tiles.length && (
        <>
          <div
            className="memory-atlas"
            data-detail={detail > 0 || tiles.length > 8}
            style={{ height }}
            aria-label="Message ranges"
            aria-busy={loading}>
            {positions.map(({ tile, box }) => (
              <button
                type="button"
                key={key(tile)}
                disabled={loading}
                aria-pressed={selected && key(selected) === key(tile)}
                aria-label={rangeLabel(tile)}
                data-size={
                  box.width < 150 || box.height < 95
                    ? 'micro'
                    : box.width < 240 || box.height < 160
                      ? 'small'
                      : 'large'
                }
                onClick={() => {
                  setSelected(tile)
                }}
                className="memory-tile"
                style={{
                  left: `${box.left / 7.2}%`,
                  top: `${(box.top / height) * 100}%`,
                  width: `${box.width / 7.2}%`,
                  height: `${(box.height / height) * 100}%`,
                }}>
                <span className="memory-tile-range">
                  <span className="memory-tile-label">{rangeLabel(tile)}</span>
                  <span className="memory-tile-short" aria-hidden="true">
                    {tile.count === 1 ? tile.id + 1 : `${tile.id + 1}–${tile.id + tile.count}`}
                  </span>
                  <ArrowUpRight className="size-3.5 shrink-0 opacity-60" />
                </span>
                <span className="memory-tile-copy">{tile.text ?? 'Summary not ready'}</span>
                <span className="memory-tile-count">
                  {tile.count === 1 ? '1 message' : `${tile.count.toLocaleString()} messages`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {selected && !loading && !error && (
        <MemoryInspector
          key={key(selected)}
          selected={selected}
          close={() => setSelected(undefined)}
          explore={() => navigate([...path, selected])}
        />
      )}
      {!!tiles.length && <MemoryOverview total={total} scope={scope} navigate={navigate} />}
    </section>
  )
}

export function MemoryScreen() {
  const { userId } = useAtomValue(stateAtom)
  return <MemoryBrowser key={userId} />
}
