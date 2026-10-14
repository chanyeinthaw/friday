import { useEffect, useRef, useState } from 'react'
import { FileText, Download, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { toast } from 'sonner'
import type { Attachment } from '../shared/Attachments.ts'
import type { PendingUpload } from './Messages.ts'
import { downloadAttachment } from './State.ts'

function ImagePreview({
  source,
  name,
  children,
}: {
  source: string
  name: string
  children: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Preview ${name}`}
          className="block h-full w-full overflow-hidden rounded-[inherit] focus-visible:outline-ring">
          {children}
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/75" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-center justify-center p-6 outline-none sm:p-16">
          <DialogPrimitive.Title className="sr-only">{name}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-xl border border-white/20 bg-black/40 text-white backdrop-blur-md"
            aria-label="Close preview">
            <X className="size-5" />
          </DialogPrimitive.Close>
          <img
            src={source}
            alt={name}
            className="max-h-full max-w-full rounded-xl object-contain"
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

const removeClass =
  'absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur-md hover:bg-black/70 focus-visible:outline-ring'

export function UploadTile({ upload, onRemove }: { upload: PendingUpload; onRemove: () => void }) {
  return (
    <div
      className="relative isolate size-14 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted/40 [clip-path:inset(0_round_0.75rem)]"
      title={upload.name}>
      {upload.source ? (
        <ImagePreview source={upload.source} name={upload.name}>
          <img
            src={upload.source}
            alt={upload.name}
            className="size-full object-cover opacity-60"
          />
        </ImagePreview>
      ) : (
        <FileText className="mx-auto mt-4 size-6 text-muted-foreground" />
      )}
      <div
        role="progressbar"
        aria-label={`Uploading ${upload.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={upload.progress}
        className="absolute inset-x-0 top-0 h-1 bg-muted">
        <div className="h-full bg-primary" style={{ width: `${upload.progress}%` }} />
      </div>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 py-0.5 text-center text-[10px] leading-4 tabular-nums">
        {upload.progress}%
      </span>
      <button
        type="button"
        aria-label={`Cancel upload ${upload.name}`}
        onClick={onRemove}
        className={removeClass}>
        <X className="size-3" />
      </button>
    </div>
  )
}

export function AttachmentItem({ file, onRemove }: { file: Attachment; onRemove?: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState('')
  const [downloading, setDownloading] = useState(false)
  const image = file.mediaType.startsWith('image/')
  useEffect(() => {
    if (!image || !element.current) return
    const controller = new AbortController()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void downloadAttachment(file.id, controller.signal).then(
          (value) => {
            if (!controller.signal.aborted) setSource(value.url)
          },
          () => undefined,
        )
      },
      { rootMargin: '200px' },
    )
    observer.observe(element.current)
    return () => {
      controller.abort()
      observer.disconnect()
    }
  }, [file.id, image])
  const download = () => {
    if (downloading) return
    setDownloading(true)
    void downloadAttachment(file.id, new AbortController().signal)
      .then(
        (value) => {
          const link = document.createElement('a')
          link.href = value.url
          link.download = value.attachment.name
          link.click()
        },
        (error: Error) => toast.error(error.message),
      )
      .finally(() => setDownloading(false))
  }
  return (
    <div
      ref={element}
      title={file.name}
      className="relative isolate size-14 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted/40 [clip-path:inset(0_round_0.75rem)]">
      {image ? (
        source ? (
          <ImagePreview source={source} name={file.name}>
            <img src={source} alt={file.name} className="size-full object-cover" />
          </ImagePreview>
        ) : (
          <div className="size-full bg-muted" />
        )
      ) : (
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          aria-label={`Download ${file.name}`}
          className="flex size-full items-center justify-center text-muted-foreground focus-visible:outline-ring">
          <FileText className="size-6" />
          <Download className="absolute bottom-1.5 right-1.5 size-3" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className={removeClass}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function MessageAttachments({ files }: { files: readonly Attachment[] | undefined }) {
  if (!files?.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {files.map((file) => (
        <AttachmentItem key={file.id} file={file} />
      ))}
    </div>
  )
}
