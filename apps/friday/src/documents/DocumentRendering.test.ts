import { assert, describe, it } from '@effect/vitest'
import {
  DocumentContentSecurityPolicy,
  documentResponseHeaders,
  renderDocumentBody,
  renderDocumentPage,
  renderMarkdown,
  sanitizeHtml,
} from './DocumentRendering.ts'

describe('markdown rendering', () => {
  it('renders structure without raw HTML passthrough', () => {
    const html = renderMarkdown('# Title\n\nHello **bold** and *italic*.\n\n- one\n- two\n')
    assert.include(html, '<h1>Title</h1>')
    assert.include(html, '<strong>bold</strong>')
    assert.include(html, '<em>italic</em>')
    assert.include(html, '<ul><li>one</li><li>two</li></ul>')
    assert.notInclude(html, '<script')
  })

  it('escapes raw HTML in Markdown sources', () => {
    const html = renderMarkdown('Text <script>alert(1)</script> and <img src=x onerror=y>.')
    assert.notInclude(html, '<script')
    assert.notInclude(html, '<img')
    assert.include(html, '&lt;script&gt;')
  })

  it('renders fenced code, links, and quotes', () => {
    const html = renderMarkdown(
      '```\nconst x = 1\n```\n\n[Friday](https://example.com) and [evil](javascript:alert(1))\n\n> quoted\n',
    )
    assert.include(html, '<pre><code>const x = 1</code></pre>')
    assert.include(html, '<a href="https://example.com">Friday</a>')
    assert.notInclude(html, 'javascript:')
    assert.include(html, '<blockquote>')
  })
})

describe('HTML sanitization', () => {
  it('drops scripts, frames, handlers, and unsafe links', () => {
    const html = sanitizeHtml(
      '<p onclick="evil()">Hi</p><script>alert(1)</script><iframe src="https://x"></iframe>' +
        '<a href="javascript:alert(1)">click</a><a href="https://example.com">ok</a>',
    )
    assert.include(html, '<p>Hi</p>')
    assert.include(html, '<a href="https://example.com">ok</a>')
    assert.notInclude(html, '<script')
    assert.notInclude(html, '<iframe')
    assert.notInclude(html, 'onclick')
    assert.notInclude(html, 'javascript:')
  })

  it('keeps document structure and drops styling and forms', () => {
    const html = sanitizeHtml(
      '<h2 style="color:red">Head</h2><table><tr><td class="x">cell</td></tr></table>' +
        '<form action="/x"><input name="y"></form><style>p{}</style>',
    )
    assert.include(html, '<h2>Head</h2>')
    assert.include(html, '<table><tr><td>cell</td></tr></table>')
    assert.notInclude(html, '<form')
    assert.notInclude(html, '<style')
    assert.notInclude(html, 'style=')
  })
})

describe('document shell and headers', () => {
  it('wraps content in a bare page without branding or script', () => {
    const page = renderDocumentPage(renderDocumentBody('# Hello', 'markdown'))
    assert.include(page, '<!DOCTYPE html>')
    assert.include(page, '<h1>Hello</h1>')
    assert.include(page, '<style>')
    assert.notInclude(page, '<script')
    assert.notInclude(page, '<title')
    assert.notInclude(page.toLowerCase(), 'friday')
  })

  it('sets restrictive security headers', () => {
    const headers = documentResponseHeaders()
    assert.strictEqual(headers['content-type'], 'text/html; charset=utf-8')
    assert.strictEqual(headers['cache-control'], 'private, no-store')
    assert.strictEqual(headers['referrer-policy'], 'no-referrer')
    assert.strictEqual(headers['x-content-type-options'], 'nosniff')
    assert.strictEqual(headers['x-robots-tag'], 'noindex, nofollow, noarchive')
    assert.strictEqual(headers['content-security-policy'], DocumentContentSecurityPolicy)
    assert.match(headers['content-security-policy'] ?? '', /script-src 'none'/)
    assert.match(headers['content-security-policy'] ?? '', /frame-ancestors 'none'/)
  })
})
