/**
 * Renders private documents to bare, sanitized HTML.
 *
 * Markdown is rendered by a small built-in renderer that only emits an
 * allow-list of structural tags. Supplied HTML is passed through the same
 * allow-list sanitizer. The page shell carries document structure and minimal
 * typography only: no branding, title, navigation, metadata, timestamps,
 * footer, or JavaScript.
 */

const AllowedTags = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

const VoidTags = new Set(['br', 'hr', 'img'])

/** Elements dropped together with their content; everything else keeps its text. */
const DropWithContent = new Set([
  'applet',
  'base',
  'embed',
  'frame',
  'frameset',
  'head',
  'html',
  'body',
  'iframe',
  'link',
  'meta',
  'noscript',
  'object',
  'script',
  'slot',
  'style',
  'template',
  'title',
])

/** Escapes untrusted text for HTML inclusion. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const safeLinkHref = (href: string): string | undefined => {
  const value = href.trim()
  if (value.startsWith('#') && value.length > 1 && !/[\s"'<>]/.test(value)) return value
  const lower = value.toLowerCase()
  if ((lower.startsWith('https://') || lower.startsWith('http://')) && !/[\s"'<>]/.test(value)) {
    return value
  }
  return undefined
}

const safeImageSrc = (src: string): string | undefined => {
  const value = src.trim()
  const lower = value.toLowerCase()
  if (lower.startsWith('https://') && !/[\s"'<>]/.test(value)) return value
  if (lower.startsWith('data:image/') && !/[\s"'<>]/.test(value)) return value
  return undefined
}

const dropElementWithContent = (html: string, tag: string): string => {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
  return html.replaceAll(pattern, '')
}

const dropVoidElement = (html: string, tag: string): string => {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi')
  return html.replaceAll(pattern, '')
}

const parseAttributes = (
  raw: string,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const attributes: Array<{ readonly name: string; readonly value: string }> = []
  const pattern = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g
  for (const match of raw.matchAll(pattern)) {
    const name = (match[1] ?? '').toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (name.length > 0) attributes.push({ name, value })
  }
  return attributes
}

/**
 * Strips everything outside a small structural allow-list. Links keep only
 * safe `href` values, images keep only safe `src` plus `alt`; every other
 * attribute is removed.
 */
export const sanitizeHtml = (html: string): string => {
  let cleaned = html.replaceAll(/<!--[\s\S]*?-->/g, '')
  cleaned = cleaned.replaceAll(/<\?.*?\?>/gs, '')
  cleaned = cleaned.replaceAll(/<![a-zA-Z][^>]*>/g, '')
  for (const tag of DropWithContent) {
    cleaned =
      VoidTags.has(tag) || tag === 'embed' || tag === 'link' || tag === 'meta' || tag === 'base'
        ? dropVoidElement(cleaned, tag)
        : dropElementWithContent(cleaned, tag)
  }
  return cleaned.replaceAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (_match, closing: string, name: string, raw: string) => {
      const tag = name.toLowerCase()
      if (!AllowedTags.has(tag)) return ''
      if (closing === '/') return VoidTags.has(tag) ? '' : `</${tag}>`
      if (tag === 'a') {
        const href = parseAttributes(raw).find((attribute) => attribute.name === 'href')?.value
        const safe = href === undefined ? undefined : safeLinkHref(href)
        return safe === undefined ? '<a>' : `<a href="${escapeHtml(safe)}">`
      }
      if (tag === 'img') {
        const attributes = parseAttributes(raw)
        const src = attributes.find((attribute) => attribute.name === 'src')?.value
        const alt = attributes.find((attribute) => attribute.name === 'alt')?.value ?? ''
        const safe = src === undefined ? undefined : safeImageSrc(src)
        return safe === undefined
          ? escapeHtml(alt)
          : `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" />`
      }
      if (tag === 'br') return '<br />'
      if (tag === 'hr') return '<hr />'
      return `<${tag}>`
    },
  )
}

const renderInline = (source: string): string => {
  const slots: Array<string> = []
  const stash = (html: string): string => {
    slots.push(html)
    return `\uE000${slots.length - 1}\uE001`
  }
  const escaped = escapeHtml(source)
  const withCode = escaped.replaceAll(/`([^`\n]+)`/g, (_match, code: string) =>
    stash(`<code>${code}</code>`),
  )
  const withImages = withCode.replaceAll(
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\)/g,
    (_match, alt: string, src: string) => {
      const safe = safeImageSrc(src)
      const text = escapeHtml(decodeEntities(alt))
      return safe === undefined
        ? stash(text)
        : stash(`<img src="${escapeHtml(safe)}" alt="${text}" />`)
    },
  )
  const withLinks = withImages.replaceAll(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\)/g,
    (_match, label: string, href: string) => {
      const safe = safeLinkHref(href)
      const rendered = renderEmphasis(label)
      return safe === undefined
        ? stash(rendered)
        : stash(`<a href="${escapeHtml(safe)}">${rendered}</a>`)
    },
  )
  const emphasized = renderEmphasis(withLinks)
  return emphasized.replaceAll(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => slots[Number(index)] ?? '',
  )
}

const decodeEntities = (text: string): string =>
  text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")

const renderEmphasis = (source: string): string =>
  source
    .replaceAll(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replaceAll(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replaceAll(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')

/** Renders Markdown to an allow-listed HTML fragment (no page shell). */
export const renderMarkdown = (source: string): string => {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const blocks: Array<string> = []
  let paragraph: Array<string> = []
  let list: { readonly ordered: boolean; readonly items: Array<string> } | null = null
  let quote: Array<string> = []
  let fence: Array<string> = []
  let inFence = false
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInline(paragraph.join(' ').replaceAll(/  +/g, '<br />'))}</p>`)
    }
    paragraph = []
  }
  const flushList = (): void => {
    if (list !== null) {
      const tag = list.ordered ? 'ol' : 'ul'
      blocks.push(
        `<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`,
      )
    }
    list = null
  }
  const flushQuote = (): void => {
    if (quote.length > 0) {
      blocks.push(`<blockquote><p>${renderInline(quote.join(' '))}</p></blockquote>`)
    }
    quote = []
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      if (inFence && /^```\s*$/.test(trimmed)) {
        blocks.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
        fence = []
        inFence = false
      } else if (!inFence) {
        flushParagraph()
        flushList()
        flushQuote()
        inFence = true
      } else {
        fence.push(line)
      }
      continue
    }
    if (inFence) {
      fence.push(line)
      continue
    }
    if (trimmed === '') {
      flushParagraph()
      flushList()
      flushQuote()
      continue
    }
    const quoteLine = /^>\s?(.*)$/.exec(line)
    if (quoteLine !== null) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1] ?? '')
      continue
    }
    flushQuote()
    const heading = parseHeading(trimmed)
    if (heading !== null) {
      flushParagraph()
      flushList()
      blocks.push(heading)
      continue
    }
    if (/^(---|\*\*\*|___)$/.test(trimmed)) {
      flushParagraph()
      flushList()
      blocks.push('<hr />')
      continue
    }
    const item = parseListItem(line)
    if (item !== null) {
      flushParagraph()
      if (list === null || list.ordered !== item.ordered) {
        flushList()
        list = { ordered: item.ordered, items: [item.item] }
      } else {
        list.items.push(item.item)
      }
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  if (inFence) blocks.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
  flushParagraph()
  flushList()
  flushQuote()
  return sanitizeHtml(blocks.join('\n'))
}

const parseHeading = (trimmed: string): string | null => {
  const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
  if (heading === null) return null
  const level = heading[1]?.length ?? 1
  return `<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`
}

const parseListItem = (
  line: string,
): { readonly ordered: boolean; readonly item: string } | null => {
  const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
  if (unordered !== null) return { ordered: false, item: (unordered[1] ?? '').trim() }
  const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
  if (ordered !== null) return { ordered: true, item: (ordered[1] ?? '').trim() }
  return null
}

/** Renders stored source to a sanitized HTML fragment for the page shell. */
export const renderDocumentBody = (source: string, format: 'markdown' | 'html'): string =>
  format === 'html' ? sanitizeHtml(source) : renderMarkdown(source)

const PageStyle = [
  'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6;',
  'margin:0 auto;max-width:42rem;padding:2rem 1rem;color:#1a1a1a;background:#fff}',
  'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.5em 0 .5em}',
  'p,ul,ol,blockquote,pre,table{margin:0 0 1em}',
  'pre{background:#f5f5f5;padding:1rem;overflow:auto}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
  'pre code{background:none;padding:0}',
  'blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1rem;color:#444}',
  'table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.4rem .7rem}',
  'img{max-width:100%}',
].join('')

/** Wraps a sanitized fragment in the bare document shell (no branding or script). */
export const renderDocumentPage = (body: string): string =>
  [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<style>${PageStyle}</style>`,
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')

export const DocumentContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src 'none'; connect-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Security headers for a served document. No store, no referrer, no indexing. */
export const documentResponseHeaders = () =>
  ({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'content-security-policy': DocumentContentSecurityPolicy,
  }) satisfies Record<string, string>

/** Indistinguishable missing/unauthorized response headers. */
export const documentNotFoundHeaders = () =>
  ({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }) satisfies Record<string, string>

export const DocumentNotFoundBody = 'Not found\n'
