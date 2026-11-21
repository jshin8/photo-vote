import { photoUrl, thumbUrl } from './supabase'

export const MAX_BYTES = 5 * 1024 * 1024
export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export type Category = 'entree' | 'dessert'
export const CATEGORIES: { id: Category; label: string; singular: string }[] = [
  { id: 'entree', label: 'Savory', singular: 'savory dish' },
  { id: 'dessert', label: 'Sweet', singular: 'sweet dish' },
]

/** Display title for an entry: the dish name, falling back to the person's name for older entries. */
export function dishTitle(e: { name: string; dish: string | null }) {
  return e.dish || e.name
}
/** "by <person>" line, shown only when there is a separate dish name. */
export function byLine(e: { name: string; dish: string | null }) {
  return e.dish ? `by ${e.name}` : ''
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) {
  return Object.assign(document.createElement(tag), props)
}

// Photos are shrunk in the browser before upload so storage and bandwidth stay
// small. Re-encoding also drops EXIF metadata such as GPS location.
// - Full photo (viewer): longest side 1200px, still sharp full-screen on a phone.
// - Thumbnail (grid, results, admin list): shorter side 400px, ~30-50 KB.
const FULL_MAX_DIMENSION = 1200
const FULL_QUALITY = 0.82
const THUMB_MIN_SIDE = 400
const THUMB_QUALITY = 0.75

async function toJpeg(file: File, scaleFor: (w: number, h: number) => number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, scaleFor(bitmap.width, bitmap.height))
  const canvas = el('canvas', {
    width: Math.round(bitmap.width * scale),
    height: Math.round(bitmap.height * scale),
  })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // JPEG has no transparency; avoid black behind transparent PNGs
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('Could not encode image')
  return blob
}

export async function shrinkImage(file: File): Promise<Blob> {
  // Redrawing an animated GIF would keep only its first frame, so upload it as-is.
  if (file.type === 'image/gif') return file
  const blob = await toJpeg(file, (w, h) => FULL_MAX_DIMENSION / Math.max(w, h), FULL_QUALITY)
  // Never upload something bigger than the original (e.g. an already-small PNG).
  return blob.size < file.size || !EXTENSIONS[file.type] ? blob : file
}

/** Small JPEG for grid/results (a GIF gets a still of its first frame). */
export function makeThumbnail(file: File): Promise<Blob> {
  return toJpeg(file, (w, h) => THUMB_MIN_SIDE / Math.min(w, h), THUMB_QUALITY)
}

/** <img> showing an entry's thumbnail, falling back to the full photo if there isn't one. */
export function thumbImg(path: string, props: Partial<HTMLImageElement> = {}) {
  const img = el('img', { ...props, src: thumbUrl(path) })
  img.addEventListener('error', () => (img.src = photoUrl(path)), { once: true })
  return img
}

/** Run fn now and then every `ms`, skipping a tick if the previous run is still going. */
export function poll(fn: () => Promise<void>, ms: number) {
  let running = false
  const tick = async () => {
    if (running || document.hidden) return
    running = true
    try {
      await fn()
    } finally {
      running = false
    }
  }
  tick()
  setInterval(tick, ms)
  document.addEventListener('visibilitychange', tick)
}
