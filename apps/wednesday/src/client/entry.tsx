import { createRoot } from 'react-dom/client'
import { RegistryContext } from '@effect/atom-react'
import { router } from './Routes.tsx'
import { RouterProvider } from '@tanstack/react-router'
import { dispatch, registry, start } from './State.ts'
import { Message } from './Messages.ts'
import './styles.generated.css'

const container = document.getElementById('app')
if (container)
  createRoot(container).render(
    <RegistryContext.Provider value={registry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
  )
void start().catch(() =>
  dispatch(Message.Failed({ message: 'Unable to open Friday. Please reload.' })),
)
