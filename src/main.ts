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
      ...state.entries.map((entry) => {
        const card = el('figure', { className: 'card' })
        card.dataset.id = entry.id
        const button = el('button', { type: 'button' })
        button.addEventListener('click', () => vote(entry.id))
        card.append(
          el('img', { src: photoUrl(entry.photo_path), alt: entry.name, loading: 'lazy' }),
          el('figcaption', { textContent: entry.name }),
          button,
        )
        return card
      }),
    )
  }

  entriesEl.querySelectorAll<HTMLElement>('.card').forEach((card) => {
    const mine = card.dataset.id === state.myVote
    card.classList.toggle('voted', mine)
    const button = card.querySelector('button')!
    button.textContent = mine ? '✓ Your vote' : state.myVote ? 'Switch to this' : 'Vote'
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
    ...state.results.map((r) => {
      const li = el('li')
      if (top > 0 && r.votes === top) li.classList.add('winner')
      const track = el('span', { className: 'track' })
      const bar = el('span', { className: 'bar' })
      bar.style.width = `${(r.votes / max) * 100}%`
      track.append(bar)
      li.append(
        el('img', { src: photoUrl(r.photo_path), alt: '' }),
        el('span', { className: 'name', textContent: r.name }),
        track,
        el('span', { className: 'count', textContent: `${r.votes} vote${r.votes === 1 ? '' : 's'}` }),
      )
      return li
    }),
  )
}

// ---------- Start ----------

if (isConfigured) {
  render()
  poll(refresh, 5000)
} else {
  $('#setup-warning').hidden = false
}
