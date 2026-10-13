import { Effect } from 'effect'
import DOMPurify from 'dompurify'
import { useEffect, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Button } from '../components/ui/button.tsx'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx'

const remoteCss = /url\(\s*(?!['"]?#)[^)]*\)/gi
let purifier: ReturnType<typeof DOMPurify> | undefined
function sanitize(svg: string) {
  if (!purifier) {
    purifier = DOMPurify(window)
    purifier.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName === 'style' && node.textContent)
        node.textContent = node.textContent.replace(remoteCss, 'none')
    })
    purifier.addHook('uponSanitizeAttribute', (_node, data) => {
      if (data.attrName === 'style') data.attrValue = data.attrValue.replace(remoteCss, 'none')
    })
  }
  return purifier.sanitize(svg, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
    FORBID_TAGS: ['a', 'img', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  })
}

type Result = { svg: string; error?: never } | { error: string; svg?: never }
const cache = new Map<string, Promise<Result>>()
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0
// Mermaid initialization is global, so T3 serializes rendering and caches SVGs.
function render(source: string) {
  const existing = cache.get(source)
  if (existing) return existing
  const id = `wednesday-diagram-${nextId++}`
  const result = queue.then(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { default: mermaid } = yield* Effect.tryPromise(() => import('mermaid'))
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          secure: [
            'secure',
            'securityLevel',
            'startOnLoad',
            'maxTextSize',
            'suppressErrorRendering',
            'maxEdges',
            'htmlLabels',
            'themeCSS',
          ],
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: 'default',
          fontFamily: getComputedStyle(document.body).fontFamily,
        })
        const { svg } = yield* Effect.tryPromise(() => mermaid.render(id, source))
        return { svg: sanitize(svg) } satisfies Result
      }).pipe(
        Effect.catch(() => Effect.succeed<Result>({ error: 'Could not display this diagram.' })),
        Effect.ensuring(Effect.sync(() => document.getElementById(`d${id}`)?.remove())),
      ),
    ),
  )
  cache.set(source, result)
  queue = result
  void result.then(() => {
    if (cache.size > 64) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  })
  return result
}

export default function MermaidDiagram({ source }: { source: string }) {
  const [result, setResult] = useState<Result | null>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let current = true
    setResult(null)
    void render(source).then((value) => {
      if (current) setResult(value)
    })
    return () => {
      current = false
    }
  }, [source])
  if (!result) return <p className="px-4 py-8 text-sm text-muted-foreground">Loading diagram…</p>
  if (result.error) return <p className="p-4 text-sm text-muted-foreground">{result.error}</p>
  return (
    <>
      <div className="relative p-4">
        <div
          className="markdown-diagram overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: result.svg ?? '' }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          aria-label="Expand diagram"
          onClick={() => setExpanded(true)}>
          <Maximize2 className="size-4" />
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-[90vw]">
          <DialogTitle className="sr-only">Diagram</DialogTitle>
          <div
            className="markdown-diagram"
            dangerouslySetInnerHTML={{ __html: result.svg ?? '' }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
