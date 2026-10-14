import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowLeft, Brain, ChevronRight, Settings, LogOut, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { dispatch } from './State.ts'
import { Message } from './Messages.ts'
import { IntegrationsScreen } from './IntegrationsScreen.tsx'
import { MemoryScreen } from './MemoryScreen.tsx'
import { ClerkElement } from './ClerkElement.tsx'
import fridayLogo from './branding/apple-touch-icon.png'
import { Button } from './components/ui/button.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from './components/ui/sidebar.tsx'
import { useIsMobile } from './hooks/use-mobile.ts'

const route = getRouteApi('/settings')
const pages = [
  { view: 'settings', title: 'General', icon: Settings },
  { view: 'memory', title: 'Memory', icon: Brain },
  { view: 'integrations', title: 'Integrations', icon: Plug },
] as const

export function SettingsLayout({ children }: { children: ReactNode }) {
  const { view } = route.useSearch()
  const mobile = useIsMobile()
  const index = view === 'index' || (mobile && !view)
  const active = view === 'memory' || view === 'integrations' ? view : 'settings'
  return (
    <SidebarProvider className="min-h-dvh">
      <Sidebar
        collapsible="none"
        className="sticky top-0 hidden h-dvh w-56 shrink-0 border-r border-border/70 bg-muted/40 px-2 pt-3 md:flex">
        <SidebarHeader className="px-3 pb-5">
          <Link
            to="/"
            className="flex min-h-11 items-center gap-2.5 rounded-md text-sm font-semibold tracking-tight">
            <img src={fridayLogo} alt="" className="size-6 rounded-md" />
            Friday
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu aria-label="Settings pages">
                {pages.map((page) => (
                  <SidebarMenuItem key={page.view}>
                    <SidebarMenuButton asChild isActive={active === page.view}>
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
        <SidebarFooter className="gap-2 px-2 py-3">
          <Button
            variant="ghost"
            className="justify-start rounded-lg text-muted-foreground"
            onClick={() => dispatch(Message.SignOut())}>
            <LogOut className="size-4" />
            Sign out
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Link
              to="/"
              className="flex min-h-11 items-center gap-2 px-2 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" />
              Back
            </Link>
            <ClerkElement kind="account" avatarOnly />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-16 shrink-0 items-center justify-between px-5 sm:px-8 md:hidden">
          <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
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
          <Button
            variant="ghost"
            size="sm"
            className="rounded-lg text-muted-foreground"
            onClick={() => dispatch(Message.SignOut())}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </header>
        <div
          className={
            active === 'memory'
              ? 'mx-auto w-full max-w-[50rem] px-5 pt-4 pb-12 sm:px-8 md:pt-8'
              : 'mx-auto w-full max-w-[54rem] px-5 pt-4 pb-16 sm:px-8 md:pt-8 lg:pt-12'
          }>
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
          ) : active === 'integrations' ? (
            <IntegrationsScreen />
          ) : active === 'memory' ? (
            <MemoryScreen />
          ) : (
            children
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
