import type { Properties } from 'hast'
import { Schema } from 'effect'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { PluggableList } from 'unified'
import { remarkGithubAlerts } from './githubAlerts.ts'
import { remarkNormalizeListItemIndentation } from './listIndentation.ts'
const isString = Schema.is(Schema.String)

interface Node {
  type?: string
  tagName?: string
  meta?: unknown
  value?: string
  data?: { hProperties?: Properties }
  properties?: Properties
  children?: Node[]
}

function remarkCodeMeta() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.type === 'code' && isString(node.meta))
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataCodeMeta: node.meta },
        }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

// T3's bare-anchor recovery prevents a literal <A> placeholder from swallowing
// subsequent blocks when raw HTML is enabled.
function rehypeBareAnchors() {
  return (tree: Node) => {
    const anchors: Array<Node | null> = []
    let rawTextTag: string | undefined
    const visit = (node: Node) => {
      if (node.type === 'raw' && isString(node.value)) {
        const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g
        let offset = 0
        while (rawTextTag !== 'plaintext') {
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, 'gi') : tags
          matcher.lastIndex = offset
          const match = matcher.exec(node.value)
          if (!match) break
          const [tag] = match
          offset = matcher.lastIndex
          if (rawTextTag) {
            rawTextTag = undefined
            continue
          }
          if (tag.startsWith('<!--')) continue
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase()
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase()
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          )
            rawTextTag = opening
          else if (opening === 'a')
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null)
          else if (closing === 'a') anchors.pop()
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
    for (const anchor of anchors) if (anchor) anchor.type = 'text'
  }
}

const schema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'video', 'source'],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'dataCodeMeta'],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), 'dataAlert'],
    video: ['src', 'controls', 'poster', 'width', 'height', 'preload'],
    source: ['src', 'type'],
  },
}

export const remarkPlugins: PluggableList = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodeMeta,
]
function rehypeHeadingIds() {
  return (tree: Node) => {
    const taken = new Set<string>()
    const text = (node: Node): string => node.value ?? node.children?.map(text).join('') ?? ''
    const collect = (node: Node) => {
      const id = node.properties?.id
      if (isString(id)) taken.add(id)
      node.children?.forEach(collect)
    }
    collect(tree)
    const visit = (node: Node) => {
      if (node.tagName && /^h[1-6]$/.test(node.tagName) && node.properties?.id === undefined) {
        const slug = text(node)
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
          .replace(/ /g, '-')
        if (slug) {
          let suffix = 0
          let id = `user-content-${slug}`
          while (taken.has(id)) id = `user-content-${slug}-${++suffix}`
          taken.add(id)
          node.properties = { ...node.properties, id }
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

// Reserve a loading slot for figures, while keeping inline badges inline.
function rehypeStandaloneImages() {
  return (tree: Node) => {
    const soleImage = (node: Node): Node | undefined => {
      const children =
        node.children?.filter((child) => child.type !== 'text' || child.value?.trim()) ?? []
      if (children.length !== 1) return
      const child = children[0]
      if (child?.tagName === 'img') return child
      if (child && ['a', 'strong', 'em'].includes(child.tagName ?? '')) return soleImage(child)
    }
    const visit = (node: Node) => {
      if (
        node.type === 'root' ||
        ['p', 'div', 'li', 'td', 'th', 'figure', 'blockquote'].includes(node.tagName ?? '')
      ) {
        const image = soleImage(node)
        if (image) image.properties = { ...image.properties, dataStandalone: true }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

export const rehypePlugins: PluggableList = [
  rehypeBareAnchors,
  rehypeRaw,
  [rehypeSanitize, schema],
  rehypeHeadingIds,
  rehypeStandaloneImages,
]
