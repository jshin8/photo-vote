import './style.css'
import { isConfigured, photoUrl, supabase } from './supabase'
import { $, CATEGORIES, el, poll, type Category } from './shared'

type Entry = { id: string; category: Category; name: string; photo_path: string }
type Result = { entry_id: string; category: Category; name: string; photo_path: string; votes: number }

// "One vote per browser per category": a random id kept in localStorage. The
// database keeps one vote per (id, category), changeable until results are revealed.
const VOTER_KEY = 'photo-vote:voter-id'
const NAME_KEY = 'photo-vote:voter-name'
const TAB_KEY = 'photo-vote:tab'

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
  myVotes: {} as Partial<Record<Category, string>>,
  resultsVisible: false,
  results: [] as Result[],
  busy: false,
  error: '',
  tab: (sessionStorage.getItem(TAB_KEY) === 'dessert' ? 'dessert' : 'entree') as Category,
}

const nameStep = $('#name-step')
const nameForm = $<HTMLFormElement>('#name-form')
const nameInput = nameForm.querySelector('input')!
const voteSection = $('#vote')
const voteStatus = $('#vote-status')
const resultsSection = $('#results')
const resultsStatus = $('#results-status')
const viewer = $<HTMLDialogElement>('#viewer')
const viewerImg = viewer.querySelector('img')!
const viewerName = viewer.querySelector<HTMLElement>('.viewer-name')!
const viewerDetail = viewer.querySelector<HTMLElement>('.viewer-detail')!
const viewerVote = viewer.querySelector<HTMLButtonElement>('.viewer-vote')!

const entriesIn = (c: Category) => state.entries.filter((e) => e.category === c)
const resultsIn = (c: Category) => state.results.filter((r) => r.category === c)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// One panel per category, built once; the tabs show one at a time.
const voteBlocks = new Map<Category, { panel: HTMLElement; status: HTMLElement; grid: HTMLElement; key: string }>()
const resultBlocks = new Map<Category, { panel: HTMLElement; list: HTMLElement; key: string }>()
for (const c of CATEGORIES) {
  const panel = el('div', { className: 'category' })
  panel.setAttribute('role', 'tabpanel')
  const status = el('p', { className: 'status' })
  const grid = el('div', { className: 'grid' })
  panel.append(status, grid)
  $('#vote-categories').append(panel)
  voteBlocks.set(c.id, { panel, status, grid, key: '' })

  const rpanel = el('div', { className: 'category' })
  rpanel.setAttribute('role', 'tabpanel')
  const list = el('ol', { className: 'results-list' })
  rpanel.append(list)
  $('#results-categories').append(rpanel)
  resultBlocks.set(c.id, { panel: rpanel, list, key: '' })
}

const tabs = $('#tabs')
tabs.querySelectorAll<HTMLButtonElement>('[role=tab]').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.category as Category
    sessionStorage.setItem(TAB_KEY, state.tab)
    render()
    if (tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView()
  }),
)

function renderTabs() {
  tabs.querySelectorAll<HTMLButtonElement>('[role=tab]').forEach((tab) => {
    const c = tab.dataset.category as Category
    tab.setAttribute('aria-selected', String(c === state.tab))
    tab.querySelector('.tick')!.textContent = state.myVotes[c] ? '✓' : ''
  })
  for (const c of CATEGORIES) {
    voteBlocks.get(c.id)!.panel.hidden = c.id !== state.tab
    resultBlocks.get(c.id)!.panel.hidden = c.id !== state.tab
  }
}

// ---------- Name ----------

nameForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = nameInput.value.trim()
  if (!name) return
  state.name = name
  localStorage.setItem(NAME_KEY, name)
  // Keep the name on existing votes in sync.
  if (!state.resultsVisible) for (const id of Object.values(state.myVotes)) if (id) await vote(id)
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
  const entry = state.entries.find((e) => e.id === entryId)
  if (!entry) return
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
    state.error =
      error.code === 'PV001'
        ? ''
        : error.code === 'PV003'
          ? 'That photo was removed. Please pick another.'
          : 'Could not record your vote. Please try again.'
    await refresh()
    return
  }
  state.error = ''
  state.myVotes[entry.category] = entryId
  render()
}

// ---------- Data ----------

let loadedMyVotes = false

async function refresh() {
  const [visible, entries] = await Promise.all([
    supabase.rpc('results_visible'),
    supabase.from('entries').select('id, category, name, photo_path').order('created_at', { ascending: true }),
  ])
  if (visible.error || entries.error) {
    console.error(visible.error ?? entries.error)
    return
  }
  state.resultsVisible = Boolean(visible.data)
  state.entries = entries.data as Entry[]

  if (!loadedMyVotes) {
    const mine = await supabase.rpc('my_vote', { p_voter_id: voterId() })
    if (!mine.error) {
      for (const row of mine.data as { category: Category; entry_id: string }[]) {
        state.myVotes[row.category] = row.entry_id
      }
      loadedMyVotes = true
    }
  }

  if (state.resultsVisible) {
    const results = await supabase.rpc('results')
    if (!results.error) state.results = results.data as Result[]
  }
  render()
}

// ---------- Render ----------

function render() {
  const hasName = Boolean(state.name)
  $('#whoami').hidden = !hasName
  $('#whoami-name').textContent = state.name
  nameStep.hidden = hasName

  voteSection.hidden = !hasName || state.resultsVisible
  resultsSection.hidden = !state.resultsVisible
  tabs.hidden = voteSection.hidden && resultsSection.hidden
  renderTabs()

  if (state.resultsVisible) renderResults()
  else if (hasName) renderVoting()
  if (viewer.open) renderViewer()
}

function voteLabel(entry: { id: string; category: Category }) {
  const mine = state.myVotes[entry.category]
  return entry.id === mine ? '✓ Your vote' : mine ? 'Switch to this' : 'Vote'
}

function renderVoting() {
  const missing = CATEGORIES.filter((c) => !state.myVotes[c.id])
  voteStatus.textContent =
    state.error ||
    (!state.entries.length
      ? 'No photos yet. Check back soon.'
      : !missing.length
        ? 'Thanks for voting! You can change your votes until the results are revealed.'
        : missing.length < CATEGORIES.length
          ? `Don't forget to vote for ${missing.map((c) => c.label.toLowerCase()).join(' and ')} too.`
          : 'You get one vote for entrées and one for desserts.')

  for (const c of CATEGORIES) {
    const block = voteBlocks.get(c.id)!
    const entries = entriesIn(c.id)
    const mine = entries.find((e) => e.id === state.myVotes[c.id])
    block.status.textContent = !entries.length
      ? `No ${c.label.toLowerCase()} yet.`
      : mine
        ? `✓ You voted for ${mine.name}.`
        : `Pick your favourite ${c.singular}.`

    // Rebuild cards only when entries change, so images don't flicker on each poll.
    const key = JSON.stringify(entries)
    if (key !== block.key) {
      block.key = key
      block.grid.replaceChildren(
        ...entries.map((entry, i) => {
          const card = el('figure', { className: 'card' })
          card.dataset.id = entry.id
          const thumb = el('button', { type: 'button', className: 'thumb', ariaLabel: `View ${entry.name}` })
          thumb.append(el('img', { src: photoUrl(entry.photo_path), alt: entry.name, loading: 'lazy' }))
          thumb.addEventListener('click', () => openViewer('vote', c.id, i))
          const button = el('button', { type: 'button', className: 'vote' })
          button.addEventListener('click', () => vote(entry.id))
          card.append(thumb, el('figcaption', { textContent: entry.name }), button)
          return card
        }),
      )
    }

    block.grid.querySelectorAll<HTMLElement>('.card').forEach((card) => {
      const entry = { id: card.dataset.id!, category: c.id }
      const isMine = entry.id === state.myVotes[c.id]
      card.classList.toggle('voted', isMine)
      const button = card.querySelector<HTMLButtonElement>('button.vote')!
      button.textContent = voteLabel(entry)
      button.classList.toggle('secondary', !isMine && Boolean(state.myVotes[c.id]))
      button.disabled = state.busy || isMine
    })
  }
}

function renderResults() {
  const picks = CATEGORIES.map((c) => state.results.find((r) => r.entry_id === state.myVotes[c.id])).filter(
    (r): r is Result => Boolean(r),
  )
  resultsStatus.textContent = picks.length
    ? `Voting is closed. You voted for ${picks.map((p) => p.name).join(' and ')}.`
    : 'Voting is closed.'

  for (const c of CATEGORIES) {
    const block = resultBlocks.get(c.id)!
    const results = resultsIn(c.id)
    const key = JSON.stringify(results)
    if (key === block.key) continue
    block.key = key

    if (!results.length) {
      block.list.replaceChildren(el('li', { className: 'muted', textContent: `No ${c.label.toLowerCase()}.` }))
      continue
    }
    const max = Math.max(1, ...results.map((r) => r.votes))
    const top = results[0].votes
    block.list.replaceChildren(
      ...results.map((r, i) => {
        const li = el('li')
        if (top > 0 && r.votes === top) li.classList.add('winner')
        const track = el('span', { className: 'track' })
        const bar = el('span', { className: 'bar' })
        bar.style.width = `${(r.votes / max) * 100}%`
        track.append(bar)
        const thumb = el('button', { type: 'button', className: 'thumb', ariaLabel: `View ${r.name}` })
        thumb.append(el('img', { src: photoUrl(r.photo_path), alt: '' }))
        thumb.addEventListener('click', () => openViewer('results', c.id, i))
        li.append(
          thumb,
          el('span', { className: 'name', textContent: r.name }),
          track,
          el('span', { className: 'count', textContent: plural(r.votes, 'vote') }),
        )
        return li
      }),
    )
  }
}

// ---------- Photo viewer ----------
// Full-screen view of one photo. Swipe or use the arrows to move within its category.

let viewMode: 'vote' | 'results' = 'vote'
let viewCategory: Category = 'entree'
let viewIndex = 0

function viewItems() {
  return viewMode === 'vote'
    ? entriesIn(viewCategory).map((e) => ({ ...e, detail: '' }))
    : resultsIn(viewCategory).map((r) => ({
        id: r.entry_id,
        category: r.category,
        name: r.name,
        photo_path: r.photo_path,
        detail: plural(r.votes, 'vote'),
      }))
}

function openViewer(mode: typeof viewMode, category: Category, index: number) {
  viewMode = mode
  viewCategory = category
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
  const label = CATEGORIES.find((c) => c.id === viewCategory)!.label
  viewerDetail.textContent = [item.detail, `${label} ${viewIndex + 1} of ${items.length}`].filter(Boolean).join(' · ')
  viewerVote.hidden = viewMode !== 'vote'
  viewerVote.textContent = voteLabel(item)
  viewerVote.dataset.id = item.id
  viewerVote.disabled = state.busy || item.id === state.myVotes[item.category]
  viewer.querySelectorAll<HTMLElement>('.viewer-nav').forEach((b) => (b.hidden = items.length < 2))
}

function step(by: number) {
  const n = viewItems().length
  if (!n) return
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
