let highlighter: ReturnType<typeof import('shiki/bundle/web').createHighlighter> | undefined
const cache = new Map<string, Promise<string | null>>()

// Shiki's WASM engine avoids pathological regex hangs; load it only for code.
export function highlight(code: string, language: string): Promise<string | null> {
  const key = `${language}\n${code}`
  const cached = cache.get(key)
  if (cached) return cached
  const result = import('shiki/bundle/web')
    .then(async (module) => {
      highlighter ??= module.createHighlighter({ themes: ['github-light'], langs: [] })
      const instance = await highlighter
      const grammar = Object.entries(module.bundledLanguages).find(([id]) => id === language)?.[1]
      if (grammar) await instance.loadLanguage(grammar)
      return instance.codeToHtml(code, { lang: grammar ? language : 'text', theme: 'github-light' })
    })
    .catch(() => null)
  cache.set(key, result)
  // Bound retained source and HTML as well as the number of entries.
  let size = 0
  for (const source of cache.keys()) size += source.length * 4
  while (cache.size > 128 || size > 8_000_000) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    size -= oldest.length * 4
    cache.delete(oldest)
  }
  return result
}
