import { useEffect, useRef } from 'react'

// Clerk owns the contents and lifecycle of these browser custom elements.
export function ClerkElement({
  kind = 'auth',
  avatarOnly = false,
}: {
  kind?: 'auth' | 'account'
  avatarOnly?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = document.createElement(`wednesday-${kind}`)
    if (avatarOnly) element.setAttribute('avatar-only', '')
    ref.current?.append(element)
    return () => element.remove()
  }, [kind, avatarOnly])
  return <div ref={ref} className="min-w-0" />
}
