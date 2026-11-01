/**
 * The file viewer overlay, loaded on first use. Attachments, plan documents
 * and image previews all open it, but none needs it until something is
 * opened, so it stays out of the startup bundle (and is prefetched while
 * the app is idle, like the other lazy surfaces).
 */
import { lazySurface } from '@/lib/lazy-surface'

export const FileLightbox = lazySurface(() => import('./FileLightbox'), 'FileLightbox')
