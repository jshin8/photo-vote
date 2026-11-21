import './style.css'
import { BUCKET, isConfigured, photoUrl, supabase } from './supabase'
import { $, el, EXTENSIONS, MAX_BYTES, poll, shrinkImage } from './shared'

type AdminResult = { entry_id: string; name: string; photo_path: string; votes: number; voters: string[] }

// The passcode is kept for this tab only and sent with every admin call; the
// database checks it each time, so this page itself grants nothing.
const CODE_KEY = 'photo-vote:admin-code'
let code = sessionStorage.getItem(CODE_KEY) ?? ''

const loginSection = $('#login')
const loginForm = $<HTMLFormElement>('#login-form')
const loginStatus = $('#login-status')
const dashboard = $('#dashboard')
const logoutButton = $('#logout')
const visibilityStatus = $('#visibility-status')
const toggleButton = $<HTMLButtonElement>('#toggle-results')
const addForm = $<HTMLFormElement>('#add-form')
const addStatus = $('#add-status')
const listStatus = $('#list-status')
const listEl = $('#admin-list')
const totalEl = $('#total')

let resultsVisible = false
let polling = false

function isWrongPasscode(error: { code?: string } | null) {
  return error?.code === '28P01'
}

function showLogin(message = '') {
  code = ''
  sessionStorage.removeItem(CODE_KEY)
  loginSection.hidden = false
  dashboard.hidden = true
  logoutButton.hidden = true
  loginStatus.textContent = message
}

function showDashboard() {
  loginSection.hidden = true
  dashboard.hidden = false
  logoutButton.hidden = false
  if (!polling) {
    polling = true
    poll(refresh, 5000)
  }
}

// ---------- Login ----------

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = loginForm.querySelector('input')!
  loginStatus.textContent = 'Checking…'
  const { error } = await supabase.rpc('admin_login', { p_code: input.value })
  if (error) {
    console.error(error)
    loginStatus.textContent = isWrongPasscode(error) ? 'Wrong passcode.' : 'Could not log in. Please try again.'
    return
  }
  code = input.value
  sessionStorage.setItem(CODE_KEY, code)
  loginForm.reset()
  loginStatus.textContent = ''
  showDashboard()
  await refresh()
})

logoutButton.addEventListener('click', () => showLogin())

// ---------- Results visibility ----------

function renderVisibility() {
  visibilityStatus.textContent = resultsVisible
    ? 'Results are SHOWN to everyone. Voting is closed.'
    : 'Results are HIDDEN. Voting is open.'
  visibilityStatus.classList.toggle('live', resultsVisible)
  toggleButton.textContent = resultsVisible ? 'Hide results and reopen voting' : 'Show results to everyone'
}

toggleButton.addEventListener('click', async () => {
  const next = !resultsVisible
  if (next && !confirm('Show results to everyone? This closes voting.')) return
  toggleButton.disabled = true
  const { error } = await supabase.rpc('admin_set_results_visible', { p_code: code, p_visible: next })
  toggleButton.disabled = false
  if (error) {
    console.error(error)
    if (isWrongPasscode(error)) return showLogin('Your passcode is no longer valid. Please log in again.')
    alert('Could not change visibility. Please try again.')
    return
  }
  resultsVisible = next
  renderVisibility()
})

// ---------- Add photo ----------

addForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = new FormData(addForm)
  const name = String(data.get('name') ?? '').trim()
  const file = data.get('photo') as File | null
  if (!name) return (addStatus.textContent = 'Please enter a name.')
  if (!file || !file.size) return (addStatus.textContent = 'Please choose a photo.')
  if (!file.type.startsWith('image/')) return (addStatus.textContent = 'Please choose an image file.')

  const button = addForm.querySelector('button')!
  button.disabled = true
  addStatus.textContent = 'Preparing photo…'
  try {
    let photo: Blob
    try {
      photo = await shrinkImage(file)
    } catch (err) {
      console.warn('Resize failed, uploading original', err)
      photo = file
    }
    const ext = EXTENSIONS[photo.type]
    if (!ext) return (addStatus.textContent = 'Photo must be JPEG, PNG, WebP or GIF.')
    if (photo.size > MAX_BYTES) return (addStatus.textContent = 'Photo must be 5 MB or smaller.')

    addStatus.textContent = 'Uploading…'
    const reserve = await supabase.rpc('admin_reserve_upload', { p_code: code, p_ext: ext })
    if (reserve.error) throw reserve.error
    const path = reserve.data as string

    const upload = await supabase.storage.from(BUCKET).upload(path, photo, { contentType: photo.type })
    if (upload.error) throw upload.error

    const add = await supabase.rpc('admin_add_entry', { p_code: code, p_name: name, p_photo_path: path })
    if (add.error) throw add.error

    addForm.reset()
    addStatus.textContent = `Added "${name}".`
    addForm.querySelector<HTMLInputElement>('input[name=name]')!.focus()
    await refresh()
  } catch (err) {
    console.error(err)
    if (isWrongPasscode(err as { code?: string })) return showLogin('Your passcode is no longer valid. Please log in again.')
    addStatus.textContent = 'Something went wrong. Please try again.'
  } finally {
    button.disabled = false
  }
})

// ---------- List ----------

async function deleteEntry(r: AdminResult) {
  const warning = r.votes ? ` It has ${r.votes} vote${r.votes === 1 ? '' : 's'}, which will also be deleted.` : ''
  if (!confirm(`Delete "${r.name}"?${warning}`)) return
  const { error } = await supabase.rpc('admin_delete_entry', { p_code: code, p_entry_id: r.entry_id })
  if (error) {
    console.error(error)
    if (isWrongPasscode(error)) return showLogin('Your passcode is no longer valid. Please log in again.')
    alert('Could not delete. Please try again.')
    return
  }
  await refresh()
}

let lastKey = ''

function renderList(results: AdminResult[]) {
  const total = results.reduce((n, r) => n + r.votes, 0)
  totalEl.textContent = `· ${results.length} photo${results.length === 1 ? '' : 's'}, ${total} vote${total === 1 ? '' : 's'}`
  listStatus.textContent = results.length ? '' : 'No photos yet. Add one above.'

  const key = JSON.stringify(results)
  if (key === lastKey) return
  lastKey = key

  const top = Math.max(0, ...results.map((r) => r.votes))
  listEl.replaceChildren(
    ...results.map((r) => {
      const li = el('li', { className: 'admin-item' })
      if (top > 0 && r.votes === top) li.classList.add('winner')
      const info = el('div')
      info.append(
        el('strong', { textContent: r.name }),
        el('span', { className: 'count', textContent: ` · ${r.votes} vote${r.votes === 1 ? '' : 's'}` }),
        el('p', { className: 'voters', textContent: r.voters.length ? r.voters.join(', ') : 'No votes yet' }),
      )
      const del = el('button', { type: 'button', className: 'secondary danger', textContent: 'Delete' })
      del.addEventListener('click', () => deleteEntry(r))
      li.append(el('img', { src: photoUrl(r.photo_path), alt: '' }), info, del)
      return li
    }),
  )
}

async function refresh() {
  if (!code) return
  const [results, visible] = await Promise.all([
    supabase.rpc('admin_results', { p_code: code }),
    supabase.rpc('results_visible'),
  ])
  if (isWrongPasscode(results.error)) return showLogin('Your passcode is no longer valid. Please log in again.')
  if (results.error || visible.error) {
    console.error(results.error ?? visible.error)
    listStatus.textContent = 'Could not load. Retrying…'
    return
  }
  resultsVisible = Boolean(visible.data)
  renderVisibility()
  renderList(results.data as AdminResult[])
}

// ---------- Start ----------

if (!isConfigured) {
  $('#setup-warning').hidden = false
} else if (code) {
  showDashboard()
} else {
  showLogin()
}
