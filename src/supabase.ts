import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_KEY as string | undefined

export const isConfigured = Boolean(url && key)

// Placeholder values keep the client constructible so the page can show a setup notice.
export const supabase = createClient(url || 'http://localhost', key || 'missing-key')

export const BUCKET = 'photos'

export function photoUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Thumbnail stored next to each photo: <uuid>.<ext> -> <uuid>.thumb.jpg */
export function thumbUrl(path: string): string {
  return photoUrl(path.replace(/\.[a-z]+$/, '.thumb.jpg'))
}

/** File names are unique and never overwritten, so browsers can cache them for a year. */
export const CACHE_SECONDS = String(60 * 60 * 24 * 365)
