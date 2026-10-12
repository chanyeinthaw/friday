export const messageCharacters = 30_000

// Preserve every Unicode code point across adjacent messages; only tool echoes are clipped.
export const splitText = (text: string): readonly string[] => {
  const characters = Array.from(text)
  if (!characters.length) return ['']
  const pages: string[] = []
  for (let start = 0; start < characters.length; start += messageCharacters)
    pages.push(characters.slice(start, start + messageCharacters).join(''))
  return pages
}
export const clipToolOutput = (text: string): string => {
  const characters = Array.from(text)
  if (characters.length <= messageCharacters) return text
  return (
    characters.slice(0, messageCharacters / 2).join('') +
    characters.slice(-messageCharacters / 2).join('')
  )
}
