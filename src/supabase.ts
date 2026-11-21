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
