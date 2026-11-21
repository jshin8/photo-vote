import './style.css'
import { BUCKET, CACHE_SECONDS, isConfigured, supabase } from './supabase'
import {
  $,
  byLine,
  CATEGORIES,
  dishTitle,
  el,
  EXTENSIONS,
  makeThumbnail,
  MAX_BYTES,
  poll,
  shrinkImage,
  thumbImg,
  type Category,
} from './shared'

type AdminResult = {
  entry_id: string
  category: Category
  name: string
  dish: string | null
  photo_path: string
  votes: number
  voters: string[]
}

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
  const dish = String(data.get('dish') ?? '').trim()
  const category = String(data.get('category') ?? '') as Category
  const file = data.get('photo') as File | null
  if (!CATEGORIES.some((c) => c.id === category)) return (addStatus.textContent = 'Please choose a category.')
  if (!dish) return (addStatus.textContent = 'Please enter the dish name.')
  if (!name) return (addStatus.textContent = 'Please enter who made it.')
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

    const upload = await supabase.storage
      .from(BUCKET)
      .upload(path, photo, { contentType: photo.type, cacheControl: CACHE_SECONDS })
    if (upload.error) throw upload.error

    // Small thumbnail for the grid and results. If it fails, pages fall back to the full photo.
    try {
      const thumb = await makeThumbnail(file)
      const thumbUpload = await supabase.storage
        .from(BUCKET)
        .upload(path.replace(/\.[a-z]+$/, '.thumb.jpg'), thumb, { contentType: 'image/jpeg', cacheControl: CACHE_SECONDS })
      if (thumbUpload.error) console.warn('Thumbnail upload failed', thumbUpload.error)
    } catch (err) {
      console.warn('Thumbnail failed', err)
    }

    const add = await supabase.rpc('admin_add_entry', {
      p_code: code,
      p_name: name,
      p_dish: dish,
      p_photo_path: path,
      p_category: category,
    })
    if (add.error) throw add.error

    // Keep the chosen category selected so several photos in a row are quick to add.
    addForm.reset()
    addForm.querySelector<HTMLInputElement>(`input[name=category][value=${category}]`)!.checked = true
    const label = CATEGORIES.find((c) => c.id === category)!.singular
    addStatus.textContent = `Added "${dish}" by ${name} (${label}).`
    addForm.querySelector<HTMLInputElement>('input[name=dish]')!.focus()
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

async function editEntry(r: AdminResult) {
  const dish = prompt('Dish name:', r.dish ?? '')?.trim()
  if (!dish) return
  const name = prompt('Made by:', r.name)?.trim()
  if (!name) return
  const { error } = await supabase.rpc('admin_update_entry', {
    p_code: code,
    p_entry_id: r.entry_id,
    p_name: name,
    p_dish: dish,
  })
  if (error) {
    console.error(error)
    if (isWrongPasscode(error)) return showLogin('Your passcode is no longer valid. Please log in again.')
    alert('Could not save. Please try again.')
    return
  }
  await refresh()
}

async function deleteEntry(r: AdminResult) {
  const warning = r.votes ? ` It has ${r.votes} vote${r.votes === 1 ? '' : 's'}, which will also be deleted.` : ''
  if (!confirm(`Delete "${dishTitle(r)}"?${warning}`)) return
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

  $('#admin-categories').replaceChildren(
    ...CATEGORIES.map((c) => {
      const items = results.filter((r) => r.category === c.id)
      const votes = items.reduce((n, r) => n + r.votes, 0)
      const section = el('section', { className: 'category' })
      section.append(
        el('h3', {
          textContent: `${c.label} · ${items.length} photo${items.length === 1 ? '' : 's'}, ${votes} vote${votes === 1 ? '' : 's'}`,
        }),
      )
      const list = el('ul', { className: 'admin-list' })
      const top = Math.max(0, ...items.map((r) => r.votes))
      list.append(
        ...items.map((r) => {
          const li = el('li', { className: 'admin-item' })
          if (top > 0 && r.votes === top) li.classList.add('winner')
          const info = el('div')
          info.append(
            el('strong', { textContent: r.dish ? dishTitle(r) : `${r.name} (no dish name yet)` }),
            el('span', { className: 'by', textContent: byLine(r) }),
            el('span', { className: 'count', textContent: ` · ${r.votes} vote${r.votes === 1 ? '' : 's'}` }),
            el('p', { className: 'voters', textContent: r.voters.length ? r.voters.join(', ') : 'No votes yet' }),
          )
          const del = el('button', { type: 'button', className: 'secondary danger', textContent: 'Delete' })
          del.addEventListener('click', () => deleteEntry(r))
          const edit = el('button', { type: 'button', className: 'secondary', textContent: 'Edit' })
          edit.addEventListener('click', () => editEntry(r))
          const actions = el('div', { className: 'actions' })
          actions.append(edit, del)
          li.append(thumbImg(r.photo_path, { alt: '' }), info, actions)
          return li
        }),
      )
      if (!items.length) list.append(el('li', { className: 'muted', textContent: `No ${c.label.toLowerCase()} dishes yet.` }))
      section.append(list)
      return section
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
