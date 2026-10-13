import { Schema } from 'effect'
import {
  Children,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  Check,
  Copy,
  Maximize2,
  Minimize2,
  WrapText,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button.tsx'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.tsx'
import { remarkPlugins, rehypePlugins } from './pipeline.ts'
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from './clipboard.ts'
import { highlight } from './highlighting.ts'
const isString = Schema.is(Schema.String)
const isNumber = Schema.is(Schema.Number)

const MermaidDiagram = lazy(() => import('./MermaidDiagram.tsx'))

function plainText(node: ReactNode): string {
  if (isString(node) || isNumber(node)) return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children)
  return ''
}

function CopyButton({ text, label = 'Copy code' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => toast.error('Could not copy.'))
      }}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

function CodeBlock({ code, language, meta }: { code: string; language: string; meta?: string }) {
  const [wrap, setWrap] = useState(false)
  const [source, setSource] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const diagram = language === 'mermaid'
  const titleMatch = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
    meta ?? '',
  )
  const title =
    titleMatch?.[1] ??
    titleMatch?.[2] ??
    titleMatch?.[3] ??
    meta?.split(/\s+/).find((part) => /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/.test(part))
  useEffect(() => {
    let current = true
    setHtml(null)
    if (!diagram || source)
      void highlight(code, language === 'gitignore' ? 'ini' : language).then((value) => {
        if (current) setHtml(value)
      })
    return () => {
      current = false
    }
  }, [code, language, diagram, source])
  return (
    <div
      className="chat-markdown-codeblock overflow-hidden rounded-xl border bg-secondary/40"
      data-wrap={wrap}
      data-language={language}>
      <div className="chat-markdown-codeblock-header flex min-h-10 items-center justify-between gap-2 border-b px-3 text-xs text-muted-foreground select-none">
        <span className="truncate">{title ?? language}</span>
        <div className="flex shrink-0 items-center gap-1">
          {diagram && (
            <Button variant="ghost" size="sm" onClick={() => setSource((value) => !value)}>
              {source ? 'Diagram' : 'Source'}
            </Button>
          )}
          {(!diagram || source) && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Wrap code"
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}>
              <WrapText className="size-3.5" />
            </Button>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      {diagram && !source ? (
        <Suspense
          fallback={
            <pre>
              <code>{code}</code>
            </pre>
          }>
          <MermaidDiagram source={code} />
        </Suspense>
      ) : html ? (
        <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

function MarkdownTable({ children, ...props }: ComponentProps<'table'>) {
  const ref = useRef<HTMLTableElement>(null)
  const [expanded, setExpanded] = useState(false)
  const copy = (format: 'markdown' | 'csv') => {
    if (!ref.current) return
    const text =
      format === 'markdown'
        ? serializeTableElementToMarkdown(ref.current)
        : serializeTableElementToCsv(ref.current)
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success('Table copied'))
      .catch(() => toast.error('Could not copy.'))
  }
  return (
    <div className="chat-markdown-table-container" data-expanded={expanded}>
      <div className="overflow-x-auto rounded-xl border">
        <table ref={ref} {...props}>
          {children}
        </table>
      </div>
      <div className="mt-1 flex items-center justify-between select-none">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expanded ? 'Collapse table cells' : 'Expand table cells'}
          aria-pressed={expanded}
          onClick={() => {
            if (!expanded && ref.current) {
              const widths: number[] = []
              for (const row of ref.current.rows)
                for (const [index, cell] of [...row.cells].entries())
                  widths[index] = Math.max(widths[index] ?? 0, cell.getBoundingClientRect().width)
              for (const [index, cell] of [...(ref.current.tHead?.rows[0]?.cells ?? [])].entries())
                cell.style.minWidth = `${widths[index] ?? 0}px`
            }
            setExpanded((value) => !value)
          }}>
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Copy table">
              <Copy className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => copy('markdown')}>
              Copy as Markdown
            </Button>
            <Button variant="ghost" className="w-full justify-start" onClick={() => copy('csv')}>
              Copy as CSV
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function MarkdownImage({
  src,
  alt,
  title,
  standalone,
  ...props
}: ComponentProps<'img'> & { standalone: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [gallery, setGallery] = useState<readonly { src: string; alt: string }[]>([])
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLImageElement>(null)
  const open = () => {
    const images = [
      ...(ref.current?.closest('.chat-markdown')?.querySelectorAll('img[role="button"]') ?? []),
    ]
      .filter((image): image is HTMLImageElement => image instanceof HTMLImageElement)
      .map((image) => ({ src: image.src, alt: image.alt }))
    setGallery(images)
    setIndex(
      Math.max(
        0,
        images.findIndex((image) => image.src === ref.current?.src),
      ),
    )
    setExpanded(true)
  }
  const image = gallery[index]
  const reserved = standalone && !loaded
  return (
    <>
      <span
        className={
          reserved
            ? 'relative inline-block aspect-video w-full overflow-hidden rounded-lg bg-secondary/50'
            : 'inline-block max-w-full'
        }>
        {failed ? (
          <span className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {alt || 'Image unavailable'}
          </span>
        ) : (
          <img
            {...props}
            ref={(node) => {
              ref.current = node
              if (node?.complete && node.naturalWidth) setLoaded(true)
            }}
            src={src}
            alt={alt ?? ''}
            title={title}
            loading="lazy"
            decoding="async"
            className={`max-h-[32rem] max-w-full cursor-zoom-in rounded-lg ${reserved ? 'absolute inset-0 size-full object-contain' : ''}`}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setFailed(true)
              setLoaded(false)
            }}
            onClick={open}
            role="button"
            tabIndex={0}
            aria-label={`Expand ${alt || 'image'}`}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              }
            }}
          />
        )}
      </span>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="sm:max-w-[90vw]"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1))
            if (event.key === 'ArrowRight')
              setIndex((value) => Math.min(gallery.length - 1, value + 1))
          }}>
          <DialogTitle className="sr-only">{image?.alt || alt || 'Image'}</DialogTitle>
          <img
            src={image?.src ?? src}
            alt={image?.alt ?? alt ?? ''}
            className="mx-auto max-h-[75dvh] rounded-lg object-contain"
          />
          {gallery.length > 1 && (
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous image"
                disabled={index === 0}
                onClick={() => setIndex((value) => value - 1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                {index + 1} / {gallery.length}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next image"
                disabled={index === gallery.length - 1}
                onClick={() => setIndex((value) => value + 1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function MarkdownDetails({ children, open: initiallyOpen, ...props }: ComponentProps<'details'>) {
  const [open, setOpen] = useState(initiallyOpen ?? false)
  const nodes = Children.toArray(children)
  const summary = nodes.find(
    (child) =>
      isValidElement<{ node?: { tagName?: string } }>(child) &&
      child.props.node?.tagName === 'summary',
  )
  const content = nodes.filter((child) => child !== summary)
  return (
    <details
      {...props}
      open={open}
      data-markdown-details
      data-markdown-details-open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      {summary ?? <summary>Details</summary>}
      <div>
        <div data-markdown-details-content>{content}</div>
      </div>
    </details>
  )
}

const components = {
  pre: ({ children, node }) => {
    const nodes = Children.toArray(children)
    const child = nodes[0]
    if (nodes.length !== 1 || !isValidElement<{ children?: ReactNode; className?: string }>(child))
      return <pre>{children}</pre>
    const codeNode = node?.children.find(
      (value) => value.type === 'element' && value.tagName === 'code',
    )
    const meta = codeNode?.type === 'element' ? codeNode.properties.dataCodeMeta : undefined
    const language = /\blanguage-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text'
    return (
      <CodeBlock
        code={plainText(child.props.children).replace(/\n$/, '')}
        language={language}
        {...(isString(meta) ? { meta } : {})}
      />
    )
  },
  table: ({ node: _node, ...props }) => <MarkdownTable {...props} />,
  img: ({ node, ...props }) => (
    <MarkdownImage {...props} standalone={node?.properties.dataStandalone === true} />
  ),
  details: ({ node: _node, ...props }) => <MarkdownDetails {...props} />,
  summary: ({ node: _node, ...props }) => <summary {...props} data-markdown-details-summary />,
  a: ({ node: _node, href, children, ...props }) => {
    if (href && /\.(mp4|webm|mov)(?:[?#]|$)/i.test(href) && /^https?:\/\//.test(href))
      return (
        <video
          src={href}
          controls
          preload="metadata"
          className="max-h-[32rem] max-w-full rounded-lg"
        />
      )
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (!href?.startsWith('#')) return
          const fragment = href.slice(1)
          const container = event.currentTarget.closest('.chat-markdown')
          const target = container?.querySelector(
            `#${CSS.escape(fragment)}, #${CSS.escape(`user-content-${fragment}`)}`,
          )
          if (target instanceof HTMLElement) {
            event.preventDefault()
            target.scrollIntoView({ block: 'start' })
          }
        }}
        {...(href?.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
        {children}
      </a>
    )
  },
  video: ({ node: _node, ...props }) => (
    <video {...props} controls preload="metadata" className="max-h-[32rem] max-w-full rounded-lg" />
  ),
  blockquote: ({ node, children }) => {
    const alert = node?.properties.dataAlert
    return (
      <blockquote {...(isString(alert) ? { 'data-alert': alert } : {})}>
        {isString(alert) && <p className="font-medium capitalize">{alert}</p>}
        {children}
      </blockquote>
    )
  },
  ol: ({ node: _node, start = 1, children, ...props }) => {
    const count = Children.toArray(children).filter(isValidElement).length
    const digits = String(start + Math.max(0, count - 1)).length
    return (
      <ol
        {...props}
        start={start}
        style={digits > 1 ? { paddingLeft: `${digits * 0.65 + 0.8}rem` } : undefined}>
        {children}
      </ol>
    )
  },
} satisfies Components

function ChatMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div
      className="chat-markdown min-w-0 text-sm leading-relaxed break-words"
      data-streaming={streaming ? '' : undefined}
      onCopy={(event) => {
        const selection = window.getSelection()
        if (
          !selection?.anchorNode ||
          !selection.focusNode ||
          !event.currentTarget.contains(selection.anchorNode) ||
          !event.currentTarget.contains(selection.focusNode)
        )
          return
        const payload = chatMarkdownClipboardPayload(selection)
        if (!payload) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', payload.text)
        event.clipboardData.setData('text/html', payload.html)
      }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(ChatMarkdown)
