import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Option, Schema } from 'effect'
import { AppShell, ChatScreen, SettingsScreen } from './Screen.tsx'
const SettingsSearch = Schema.Struct({
  view: Schema.optionalKey(Schema.Literals(['settings', 'memory', 'integrations', 'index'])),
})
const decodeSettingsSearch = Schema.decodeUnknownOption(SettingsSearch)
const rootRoute = createRootRoute({ component: AppShell })
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ChatScreen })
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsScreen,
  validateSearch: (search): typeof SettingsSearch.Type =>
    Option.getOrElse(decodeSettingsSearch(search), () => ({})),
})
const waitlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/waitlist',
  component: ChatScreen,
})
export const router = createRouter({
  routeTree: rootRoute.addChildren([chatRoute, settingsRoute, waitlistRoute]),
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
