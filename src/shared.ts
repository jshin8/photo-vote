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

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) {
  return Object.assign(document.createElement(tag), props)
}

// Photos are shrunk in the browser before upload so storage and bandwidth stay
// small (a 4 MB phone photo becomes ~200-400 KB). Re-encoding also drops EXIF
// metadata such as GPS location.
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.82

export async function shrinkImage(file: File): Promise<Blob> {
  // Redrawing an animated GIF would keep only its first frame, so upload it as-is.
  if (file.type === 'image/gif') return file

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const canvas = el('canvas', {
    width: Math.round(bitmap.width * scale),
    height: Math.round(bitmap.height * scale),
  })
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // JPEG has no transparency; avoid black behind transparent PNGs
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  if (!blob) throw new Error('Could not encode image')
  // Never upload something bigger than the original (e.g. an already-small PNG).
  return blob.size < file.size || !EXTENSIONS[file.type] ? blob : file
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
