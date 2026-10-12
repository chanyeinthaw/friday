import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { AppShell, ChatScreen, SettingsScreen } from './Screen.tsx'
const rootRoute = createRootRoute({ component: AppShell })
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ChatScreen })
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsScreen,
})
const waitlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/waitlist',
  component: ChatScreen,
})
export const router = createRouter({
  routeTree: rootRoute.addChildren([chatRoute, settingsRoute, waitlistRoute]),
})
