import './style.css'
import { BUCKET, isConfigured, photoUrl, supabase } from './supabase'

type Entry = { id: string; name: string; photo_path: string }
type Result = { entry_id: string; name: string; photo_path: string; votes: number }

const MAX_BYTES = 5 * 1024 * 1024
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// Photos are shrunk in the browser before upload so storage and bandwidth stay
// small (a 4 MB phone photo becomes ~200-400 KB). Re-encoding also drops EXIF
// metadata such as GPS location.
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.82

async function shrinkImage(file: File): Promise<Blob> {
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

// "One vote per browser": a random id kept in localStorage. The database's
// unique constraint on votes.voter_id enforces one vote per id.
const VOTER_KEY = 'photo-vote:voter-id'
const VOTED_KEY = 'photo-vote:voted-for'

function voterId(): string {
  let id = localStorage.getItem(VOTER_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(VOTER_KEY, id)
  }
  return id
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

const form = $<HTMLFormElement>('#submit-form')
const submitStatus = $('#submit-status')
const voteStatus = $('#vote-status')
const entriesEl = $('#entries')
const resultsEl = $('#results-list')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) {
  return Object.assign(document.createElement(tag), props)
}

// ---------- Submit ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = new FormData(form)
  const name = String(data.get('name') ?? '').trim()
  const file = data.get('photo') as File | null

  if (!name) return (submitStatus.textContent = 'Please enter a name.')
  if (!file || !file.size) return (submitStatus.textContent = 'Please choose a photo.')
  if (!file.type.startsWith('image/')) return (submitStatus.textContent = 'Please choose an image file.')

  const button = form.querySelector('button')!
  button.disabled = true
  submitStatus.textContent = 'Preparing photo…'
  try {
    let photo: Blob
    try {
      photo = await shrinkImage(file)
    } catch (err) {
      // The browser couldn't decode it (e.g. an unusual format). Fall back to the original.
      console.warn('Resize failed, uploading original', err)
      photo = file
    }
    const ext = EXTENSIONS[photo.type]
    if (!ext) return (submitStatus.textContent = 'Photo must be JPEG, PNG, WebP or GIF.')
    if (photo.size > MAX_BYTES) return (submitStatus.textContent = 'Photo must be 5 MB or smaller.')

    submitStatus.textContent = 'Uploading…'
    const path = `${crypto.randomUUID()}.${ext}`
    const upload = await supabase.storage.from(BUCKET).upload(path, photo, { contentType: photo.type })
    if (upload.error) throw upload.error

    const insert = await supabase.from('entries').insert({ name, photo_path: path })
    if (insert.error) throw insert.error

    form.reset()
    submitStatus.textContent = 'Thanks! Your entry was submitted.'
    await refresh()
  } catch (err) {
    console.error(err)
    submitStatus.textContent = 'Something went wrong. Please try again.'
  } finally {
    button.disabled = false
  }
})

// ---------- Vote ----------

async function loadEntries() {
  const { data, error } = await supabase
    .from('entries')
    .select('id, name, photo_path')
    .order('created_at', { ascending: true })
  if (error) {
    console.error(error)
    voteStatus.textContent = 'Could not load entries.'
    return
  }
  renderEntries(data as Entry[])
}

function renderEntries(entries: Entry[]) {
  const votedFor = localStorage.getItem(VOTED_KEY)
  voteStatus.textContent = votedFor
    ? 'You have already voted. Thanks!'
    : entries.length
      ? 'Pick your favourite. You get one vote.'
      : 'No entries yet. Be the first to submit one!'

  entriesEl.replaceChildren(
    ...entries.map((entry) => {
      const card = el('figure', { className: 'card' })
      if (entry.id === votedFor) card.classList.add('voted')
      card.append(
        el('img', { src: photoUrl(entry.photo_path), alt: entry.name, loading: 'lazy' }),
        el('figcaption', { textContent: entry.name }),
      )
      const button = el('button', {
        type: 'button',
        textContent: entry.id === votedFor ? 'Your vote' : 'Vote',
        disabled: Boolean(votedFor),
      })
      button.addEventListener('click', () => vote(entry.id))
      card.append(button)
      return card
    }),
  )
}

async function vote(entryId: string) {
  entriesEl.querySelectorAll('button').forEach((b) => (b.disabled = true))
  const { error } = await supabase.from('votes').insert({ entry_id: entryId, voter_id: voterId() })
  if (error && error.code !== '23505') {
    // 23505 = unique violation: this browser already voted. Anything else is a real failure.
    console.error(error)
    voteStatus.textContent = 'Could not record your vote. Please try again.'
    entriesEl.querySelectorAll('button').forEach((b) => (b.disabled = false))
    return
  }
  if (!error) localStorage.setItem(VOTED_KEY, entryId)
  else localStorage.setItem(VOTED_KEY, localStorage.getItem(VOTED_KEY) ?? 'unknown')
  await refresh()
}

// ---------- Results ----------

async function loadResults() {
  const { data, error } = await supabase.rpc('results')
  if (error) {
    console.error(error)
    resultsEl.replaceChildren(el('li', { textContent: 'Could not load results.' }))
    return
  }
  const results = data as Result[]
  const max = Math.max(1, ...results.map((r) => r.votes))
  resultsEl.replaceChildren(
    ...results.map((r) => {
      const li = el('li')
      const bar = el('span', { className: 'bar' })
      bar.style.width = `${(r.votes / max) * 100}%`
      li.append(
        el('img', { src: photoUrl(r.photo_path), alt: '', loading: 'lazy' }),
        el('span', { className: 'name', textContent: r.name }),
        el('span', { className: 'track' }),
        el('span', { className: 'count', textContent: `${r.votes} vote${r.votes === 1 ? '' : 's'}` }),
      )
      li.querySelector('.track')!.append(bar)
      return li
    }),
  )
}

async function refresh() {
  await Promise.all([loadEntries(), loadResults()])
}

$('#refresh').addEventListener('click', loadResults)

if (isConfigured) {
  refresh()
} else {
  $('#setup-warning').hidden = false
}
