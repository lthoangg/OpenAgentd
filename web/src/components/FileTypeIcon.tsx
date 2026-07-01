import { resolveFileIcon } from '@/utils/file-type-icon'
import { cn } from '@/lib/utils'

export function FileTypeIcon({ name, className, size = 14 }: { name: string; className?: string; size?: number }) {
  const src = resolveFileIcon(name)
  return <img src={src} alt="" className={cn('inline-block shrink-0 object-contain', className)} style={{ width: size, height: size }} aria-hidden="true" />
}
