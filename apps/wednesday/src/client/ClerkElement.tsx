import { useEffect, useRef } from 'react'

// Clerk owns the contents and lifecycle of these browser custom elements.
export function ClerkElement({ kind = 'auth' }: { kind?: 'auth' | 'account' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = document.createElement(`wednesday-${kind}`)
    ref.current?.append(element)
    return () => element.remove()
  }, [kind])
  return <div ref={ref} className="min-w-0" />
}
