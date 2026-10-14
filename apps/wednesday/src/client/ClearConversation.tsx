import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { clearConversation } from './State.ts'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'

export function ClearConversation({ busy }: { busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clear = () => {
    setClearing(true)
    void clearConversation().then(
      () => {
        setClearing(false)
        setOpen(false)
        toast.success('Chat and memory cleared')
      },
      () => {
        setClearing(false)
        toast.error('Could not clear your chat. Stop any response and try again.')
      },
    )
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 border-t border-border/70 pt-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Chat and memory</h2>
        <p className="text-xs text-muted-foreground">
          {busy
            ? 'Stop the response before clearing.'
            : 'Delete your messages, memories, and attachments.'}
        </p>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!clearing) setOpen(value)
        }}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg text-destructive hover:text-destructive"
            disabled={busy}>
            <Trash2 className="size-3.5" />
            Clear chat and memory
          </Button>
        </DialogTrigger>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Clear chat and memory?</DialogTitle>
            <DialogDescription>
              This permanently deletes your messages, saved memories, and attachments. Your
              connections and preferences stay. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-lg"
              disabled={clearing}
              onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="rounded-lg"
              disabled={clearing || busy}
              onClick={clear}>
              {clearing ? 'Clearing…' : 'Clear chat and memory'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
