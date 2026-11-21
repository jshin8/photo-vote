import './style.css'
import { isConfigured, photoUrl, supabase } from './supabase'
import { $, el, poll } from './shared'

type Entry = { id: string; name: string; photo_path: string }
type Result = { entry_id: string; name: string; photo_path: string; votes: number }

// "One vote per browser": a random id kept in localStorage. The database keeps
// one vote per id, which can be changed until the admin reveals the results.
const VOTER_KEY = 'photo-vote:voter-id'
const NAME_KEY = 'photo-vote:voter-name'

function voterId(): string {
  let id = localStorage.getItem(VOTER_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(VOTER_KEY, id)
  }
  return id
}

const state = {
  name: localStorage.getItem(NAME_KEY) ?? '',
  entries: [] as Entry[],
  myVote: null as string | null,
  resultsVisible: false,
  results: [] as Result[],
  busy: false,
  error: '',
}

const nameStep = $('#name-step')
const nameForm = $<HTMLFormElement>('#name-form')
const nameInput = nameForm.querySelector('input')!
const voteSection = $('#vote')
const voteStatus = $('#vote-status')
const entriesEl = $('#entries')
const resultsSection = $('#results')
const resultsStatus = $('#results-status')
const resultsEl = $('#results-list')
const viewer = $<HTMLDialogElement>('#viewer')
const viewerImg = viewer.querySelector('img')!
const viewerName = viewer.querySelector<HTMLElement>('.viewer-name')!
const viewerDetail = viewer.querySelector<HTMLElement>('.viewer-detail')!
const viewerVote = viewer.querySelector<HTMLButtonElement>('.viewer-vote')!

// ---------- Name ----------

nameForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = nameInput.value.trim()
  if (!name) return
  state.name = name
  localStorage.setItem(NAME_KEY, name)
  // Keep the name on an existing vote in sync.
  if (state.myVote && !state.resultsVisible) await vote(state.myVote)
  render()
})

$('#change-name').addEventListener('click', () => {
  nameInput.value = state.name
  state.name = ''
  render()
  nameInput.focus()
})

// ---------- Vote ----------

async function vote(entryId: string) {
  state.busy = true
  render()
  const { error } = await supabase.rpc('cast_vote', {
    p_voter_id: voterId(),
    p_voter_name: state.name,
    p_entry_id: entryId,
  })
  state.busy = false
  if (error) {
    console.error(error)
    state.error = error.code === 'PV001' ? '' : 'Could not record your vote. Please try again.'
    await refresh()
    return
  }
  state.error = ''
  state.myVote = entryId
  render()
}

// ---------- Data ----------

let loadedMyVote = false

async function refresh() {
  const [visible, entries] = await Promise.all([
    supabase.rpc('results_visible'),
    supabase.from('entries').select('id, name, photo_path').order('created_at', { ascending: true }),
  ])
  if (visible.error || entries.error) {
    console.error(visible.error ?? entries.error)
    return
  }
  state.resultsVisible = Boolean(visible.data)
  state.entries = entries.data as Entry[]

  if (!loadedMyVote) {
    const mine = await supabase.rpc('my_vote', { p_voter_id: voterId() })
    if (!mine.error) {
      state.myVote = (mine.data as string | null) ?? null
      loadedMyVote = true
    }
  }

  if (state.resultsVisible) {
    const results = await supabase.rpc('results')
    if (!results.error) state.results = results.data as Result[]
  }
  render()
}

// ---------- Render ----------

let lastEntriesKey = ''
let lastResultsKey = ''

function render() {
  const hasName = Boolean(state.name)
  $('#whoami').hidden = !hasName
  $('#whoami-name').textContent = state.name
  nameStep.hidden = hasName

  voteSection.hidden = !hasName || state.resultsVisible
  resultsSection.hidden = !state.resultsVisible
  if (!hasName && !state.resultsVisible) return

  if (!state.resultsVisible) renderVoting()
  else renderResults()
  if (viewer.open) renderViewer()
}

function voteLabel(id: string) {
  return id === state.myVote ? '✓ Your vote' : state.myVote ? 'Switch to this' : 'Vote'
}

function renderVoting() {
  voteStatus.textContent =
    state.error ||
    (!state.entries.length
      ? 'No photos yet. Check back soon.'
      : state.myVote
        ? 'Thanks for voting! You can change your vote until the results are revealed.'
        : 'Pick your favourite. You get one vote.')

  // Rebuild cards only when entries change, so images don't flicker on each poll.
  const key = JSON.stringify(state.entries)
  if (key !== lastEntriesKey) {
    lastEntriesKey = key
    entriesEl.replaceChildren(
      ...state.entries.map((entry, i) => {
        const card = el('figure', { className: 'card' })
        card.dataset.id = entry.id
        const thumb = el('button', { type: 'button', className: 'thumb', ariaLabel: `View ${entry.name}` })
        thumb.append(el('img', { src: photoUrl(entry.photo_path), alt: entry.name, loading: 'lazy' }))
        thumb.addEventListener('click', () => openViewer('vote', i))
        const button = el('button', { type: 'button', className: 'vote' })
        button.addEventListener('click', () => vote(entry.id))
        card.append(thumb, el('figcaption', { textContent: entry.name }), button)
        return card
      }),
    )
  }

  entriesEl.querySelectorAll<HTMLElement>('.card').forEach((card) => {
    const mine = card.dataset.id === state.myVote
    card.classList.toggle('voted', mine)
    const button = card.querySelector<HTMLButtonElement>('button.vote')!
    button.textContent = voteLabel(card.dataset.id!)
    button.classList.toggle('secondary', !mine && Boolean(state.myVote))
    button.disabled = state.busy || mine
  })
}

function renderResults() {
  const myPick = state.results.find((r) => r.entry_id === state.myVote)
  resultsStatus.textContent = myPick ? `Voting is closed. You voted for ${myPick.name}.` : 'Voting is closed.'

  const key = JSON.stringify(state.results)
  if (key === lastResultsKey) return
  lastResultsKey = key

  const max = Math.max(1, ...state.results.map((r) => r.votes))
  const top = state.results[0]?.votes ?? 0
  resultsEl.replaceChildren(
    ...state.results.map((r, i) => {
      const li = el('li')
      if (top > 0 && r.votes === top) li.classList.add('winner')
      const track = el('span', { className: 'track' })
      const bar = el('span', { className: 'bar' })
      bar.style.width = `${(r.votes / max) * 100}%`
      track.append(bar)
      const thumb = el('button', { type: 'button', className: 'thumb', ariaLabel: `View ${r.name}` })
      thumb.append(el('img', { src: photoUrl(r.photo_path), alt: '' }))
      thumb.addEventListener('click', () => openViewer('results', i))
      li.append(
        thumb,
        el('span', { className: 'name', textContent: r.name }),
        track,
        el('span', { className: 'count', textContent: `${r.votes} vote${r.votes === 1 ? '' : 's'}` }),
      )
      return li
    }),
  )
}

// ---------- Photo viewer ----------
// Full-screen view of one photo. Swipe or use the arrows to move between photos.

let viewMode: 'vote' | 'results' = 'vote'
let viewIndex = 0

function viewItems() {
  return viewMode === 'vote'
    ? state.entries.map((e) => ({ id: e.id, name: e.name, photo_path: e.photo_path, detail: '' }))
    : state.results.map((r) => ({
        id: r.entry_id,
        name: r.name,
        photo_path: r.photo_path,
        detail: `${r.votes} vote${r.votes === 1 ? '' : 's'}`,
      }))
}

function openViewer(mode: typeof viewMode, index: number) {
  viewMode = mode
  viewIndex = index
  renderViewer()
  document.body.classList.add('no-scroll')
  viewer.showModal()
}

function renderViewer() {
  // Voting closed (or reopened) while the viewer was open: its list no longer applies.
  if ((viewMode === 'vote') === state.resultsVisible) return viewer.close()
  const items = viewItems()
  if (!items.length) return viewer.close()
  viewIndex = Math.min(viewIndex, items.length - 1)
  const item = items[viewIndex]
  if (!viewerImg.src.endsWith(item.photo_path)) viewerImg.src = photoUrl(item.photo_path)
  viewerImg.alt = item.name
  viewerName.textContent = item.name
  viewerDetail.textContent = [item.detail, `${viewIndex + 1} of ${items.length}`].filter(Boolean).join(' · ')
  viewerVote.hidden = viewMode !== 'vote'
  viewerVote.textContent = voteLabel(item.id)
  viewerVote.dataset.id = item.id
  viewerVote.disabled = state.busy || item.id === state.myVote
  viewer.querySelectorAll<HTMLElement>('.viewer-nav').forEach((b) => (b.hidden = items.length < 2))
}

function step(by: number) {
  const n = viewItems().length
  viewIndex = (viewIndex + by + n) % n
  renderViewer()
}

viewerVote.addEventListener('click', () => vote(viewerVote.dataset.id!))
viewer.querySelector('.viewer-close')!.addEventListener('click', () => viewer.close())
viewer.querySelectorAll<HTMLElement>('.viewer-nav').forEach((b) =>
  b.addEventListener('click', () => step(Number(b.dataset.step))),
)
viewer.addEventListener('close', () => document.body.classList.remove('no-scroll'))
// Tap on the dark background (not the photo or controls) closes.
viewer.addEventListener('click', (e) => {
  if (e.target === viewer || (e.target as HTMLElement).classList.contains('viewer-stage')) viewer.close()
})
viewer.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1)
  if (e.key === 'ArrowRight') step(1)
})

let touchX: number | null = null
viewer.addEventListener('touchstart', (e) => (touchX = e.touches.length === 1 ? e.touches[0].clientX : null), {
  passive: true,
})
viewer.addEventListener('touchend', (e) => {
  if (touchX === null) return
  const dx = e.changedTouches[0].clientX - touchX
  touchX = null
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1)
})

// ---------- Start ----------

if (isConfigured) {
  render()
  poll(refresh, 5000)
} else {
  $('#setup-warning').hidden = false
}
