import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft, Brain, ChevronRight, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { ClerkElement } from './ClerkElement.tsx'
import { Button } from './components/ui/button.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from './components/ui/sidebar.tsx'
import { useIsMobile } from './hooks/use-mobile.ts'

const route = getRouteApi('/settings')
const pages = [
  { view: 'settings', title: 'Settings', icon: Settings },
  { view: 'memory', title: 'Memory', icon: Brain },
] as const

export function SettingsLayout({ children }: { children: ReactNode }) {
  const { view } = route.useSearch()
  const mobile = useIsMobile()
  const index = view === 'index' || (mobile && !view)
  const active = view === 'memory' ? 'memory' : 'settings'
  const title = active === 'memory' && !index ? 'Memory' : 'Settings'
  return (
    <SidebarProvider className="min-h-dvh">
      <Sidebar
        collapsible="none"
        className="sticky top-0 hidden h-dvh shrink-0 border-r bg-background px-3 pt-10 md:flex">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu aria-label="Settings pages">
                {pages.map((page) => (
                  <SidebarMenuItem key={page.view}>
                    <SidebarMenuButton asChild isActive={active === page.view} size="lg">
                      <Link to="/settings" search={{ view: page.view }}>
                        <page.icon />
                        <span>{page.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t py-5">
          <ClerkElement kind="account" />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <div className="mx-auto w-full max-w-6xl px-5 pt-8 pb-12 sm:px-8 md:px-10 md:pt-12 lg:px-12">
          <header className="mb-8 flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" className="border">
              {mobile && !index ? (
                <Link to="/settings" search={{}} aria-label="Back to settings">
                  <ArrowLeft />
                </Link>
              ) : (
                <Link to="/" aria-label="Back to chat">
                  <ArrowLeft />
                </Link>
              )}
            </Button>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          </header>
          {index ? (
            <>
              <nav className="overflow-hidden rounded-2xl border" aria-label="Settings pages">
                {pages.map((page) => (
                  <Link
                    key={page.view}
                    to="/settings"
                    search={{ view: page.view }}
                    className="flex min-h-16 items-center gap-3 px-5 py-4 text-sm hover:bg-muted focus-visible:outline-ring [&+a]:border-t">
                    <page.icon className="size-5 text-muted-foreground" />
                    <span className="flex-1">{page.title}</span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                ))}
              </nav>
              <div className="mt-8 md:hidden">
                <ClerkElement kind="account" />
              </div>
            </>
          ) : active === 'memory' ? (
            <p className="text-sm text-muted-foreground">Coming soon</p>
          ) : (
            children
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
