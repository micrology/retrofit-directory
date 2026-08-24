/**
 * Admin dashboard for the Retrofit Directory query service.
 *
 * Fetches the usage summary from POST /api/observe (Bearer token) and renders
 * it as formatted tables inside #admin-content. Also owns the unlock UI.
 *
 * All cell content is written with textContent rather than innerHTML: the
 * recent-query rows contain user-submitted text and must never be parsed as
 * markup.
 */

const RECENT_LIMIT = 100
const TOKEN_STORAGE_KEY = 'retrofit_admin_token'
const UNLOCK_STORAGE_KEY = 'retrofit_admin_unlocked_at'
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
const API_BASE_URL = isLocal ? 'http://localhost:5001/api' : `${window.location.origin}/retrofit`

const integerFormatter = new Intl.NumberFormat('en-GB')
const costFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})
const smallCostFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
})
const SMALL_COST_THRESHOLD_USD = 0.001

/** @returns {string | null} */
function readStoredToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

/** @param {string} token @returns {void} */
function storeToken(token) {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
    window.sessionStorage.setItem(UNLOCK_STORAGE_KEY, String(Date.now()))
  } catch {
    // Session storage unavailable; unlock lasts for this page load only.
  }
}

/** @returns {void} */
function clearStoredToken() {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    window.sessionStorage.removeItem(UNLOCK_STORAGE_KEY)
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Prefer session token; migrate legacy localStorage unlock away (it never held
 * a server secret and is no longer valid).
 * @returns {string | null}
 */
function getRememberedToken() {
  const token = readStoredToken()
  if (!token) {
    try {
      window.localStorage.removeItem(UNLOCK_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    return null
  }

  try {
    const raw = window.sessionStorage.getItem(UNLOCK_STORAGE_KEY)
    const unlockedAt = raw ? Number(raw) : NaN
    const age = Date.now() - unlockedAt
    if (!Number.isFinite(unlockedAt) || age < 0 || age > UNLOCK_TTL_MS) {
      clearStoredToken()
      return null
    }
  } catch {
    /* keep token for this session if timestamp unreadable */
  }

  return token
}

/**
 * @param {string} tag
 * @param {{ className?: string, text?: string, attrs?: Record<string,string> }} [options]
 * @param {Node[]} [children]
 * @returns {HTMLElement}
 */
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value)
  }
  node.append(...children)
  return node
}

/** @param {unknown} value @returns {string} */
function formatInteger(value) {
  if (value === null || value === undefined || value === '') return '—'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? integerFormatter.format(numeric) : '—'
}

/** @param {unknown} value @returns {string} */
function formatCost(value) {
  if (value === null || value === undefined || value === '') return '—'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  const formatter =
    numeric > 0 && numeric < SMALL_COST_THRESHOLD_USD ? smallCostFormatter : costFormatter
  return formatter.format(numeric)
}

/** @param {string | null | undefined} isoTimestamp @returns {string} */
function formatTimestamp(isoTimestamp) {
  if (!isoTimestamp) return '—'
  const date = new Date(isoTimestamp)
  return Number.isNaN(date.valueOf()) ? String(isoTimestamp) : date.toLocaleString('en-GB')
}

/**
 * @param {Array<{ label: string, key: string, numeric?: boolean, clamp?: boolean, format?: (value: any, row: any) => string, className?: string }>} columns
 * @param {any[]} rows
 * @returns {HTMLElement}
 */
function buildTable(columns, rows) {
  const headerCells = columns.map((column) =>
    el('th', {
      text: column.label,
      className: column.numeric ? 'admin-numeric' : '',
      attrs: { scope: 'col' },
    })
  )

  const bodyRows = rows.map((row) =>
    el(
      'tr',
      {},
      columns.map((column) => {
        const rawValue = row[column.key]
        const text = column.format ? column.format(rawValue, row) : String(rawValue ?? '—')
        const classNames = [column.numeric ? 'admin-numeric' : '', column.className || '']
          .filter(Boolean)
          .join(' ')

        if (column.clamp) {
          return el('td', { className: classNames }, [
            el('div', { className: 'admin-clamp', text }),
            el('span', { className: 'admin-more-hint', attrs: { 'aria-hidden': 'true' } }),
          ])
        }
        return el('td', { text, className: classNames })
      })
    )
  )

  return el('div', { className: 'admin-table-wrap' }, [
    el('table', { className: 'admin-table' }, [
      el('thead', {}, [el('tr', {}, headerCells)]),
      el('tbody', {}, bodyRows),
    ]),
  ])
}

/**
 * @param {string} title
 * @param {Node} content
 * @param {string} [note]
 * @returns {HTMLElement}
 */
function buildSection(title, content, note) {
  const children = [el('h2', { className: 'admin-section-title', text: title })]
  if (note) children.push(el('p', { className: 'admin-note', text: note }))
  children.push(content)
  return el('section', { className: 'admin-section' }, children)
}

/** @param {any} totals @returns {HTMLElement} */
function buildTotals(totals) {
  const stats = [
    { label: 'Queries', value: formatInteger(totals.requestCount) },
    { label: 'Input tokens', value: formatInteger(totals.inputTokens) },
    { label: 'Output tokens', value: formatInteger(totals.outputTokens) },
    { label: 'Total tokens', value: formatInteger(totals.totalTokens) },
    { label: 'Estimated cost', value: formatCost(totals.estimatedCostUsd) },
  ]

  return el(
    'div',
    { className: 'admin-stat-grid' },
    stats.map((stat) =>
      el('div', { className: 'admin-stat' }, [
        el('span', { className: 'admin-stat-label', text: stat.label }),
        el('span', { className: 'admin-stat-value', text: stat.value }),
      ])
    )
  )
}

/** @param {HTMLElement} row @returns {void} */
function toggleRowExpansion(row) {
  const expanded = row.classList.toggle('is-expanded')
  row.setAttribute('aria-expanded', expanded ? 'true' : 'false')
}

/** @param {HTMLElement} table @returns {void} */
function markOverflowingCells(table) {
  const measure = () => {
    for (const node of table.querySelectorAll('.admin-clamp')) {
      if (node.scrollHeight - node.clientHeight > 2) node.classList.add('is-truncated')
    }
  }

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(measure)
    return
  }
  measure()
}

/** @param {any[]} recentRequests @returns {HTMLElement} */
function buildRecentRequests(recentRequests) {
  if (recentRequests.length === 0) {
    return el('p', { className: 'admin-note', text: 'No queries recorded yet.' })
  }

  const table = buildTable(
    [
      { label: 'When', key: 'timestamp', format: formatTimestamp, className: 'admin-cell-when' },
      {
        label: 'Question',
        key: 'query',
        className: 'admin-cell-text',
        clamp: true,
        format: (value, row) =>
          row.rawQuery && row.rawQuery !== value ? `${value}\n(asked as: ${row.rawQuery})` : value,
      },
      { label: 'Answer', key: 'response', className: 'admin-cell-text', clamp: true },
      { label: 'Outcome', key: 'outcome' },
      { label: 'Rows', key: 'rowCount', numeric: true, format: formatInteger },
      { label: 'In', key: 'inputTokens', numeric: true, format: formatInteger },
      { label: 'Out', key: 'outputTokens', numeric: true, format: formatInteger },
      {
        label: 'Latency',
        key: 'latencyMs',
        numeric: true,
        format: (value) => {
          const formatted = formatInteger(value)
          return formatted === '—' ? formatted : `${formatted} ms`
        },
      },
    ],
    recentRequests
  )

  table.classList.add('admin-table-scroll')

  for (const row of table.querySelectorAll('tbody tr')) {
    row.classList.add('admin-row-expandable')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-expanded', 'false')
  }

  markOverflowingCells(table)
  return table
}

/**
 * @param {HTMLElement} container
 * @param {any} data
 * @returns {void}
 */
function renderDashboard(container, data) {
  const fragment = document.createDocumentFragment()

  const refreshButton = el('button', {
    className: 'btn-small btn-small-outline',
    text: 'Refresh',
    attrs: { type: 'button', 'data-admin-refresh': 'true' },
  })
  const lockButton = el('button', {
    className: 'btn-small btn-small-outline',
    text: 'Lock',
    attrs: { type: 'button', 'data-admin-lock': 'true' },
  })

  fragment.append(
    el('div', { className: 'admin-header' }, [
      el('h1', { className: 'admin-title', text: 'Query usage & cost' }),
      el('div', { className: 'admin-header-actions' }, [refreshButton, lockButton]),
    ])
  )

  if (data?.available === false) {
    fragment.append(
      el('p', {
        className: 'admin-error',
        text: data.error || 'The usage store is unavailable.',
      })
    )
    container.replaceChildren(fragment)
    return
  }

  const totals = data?.totals ?? {}
  fragment.append(buildTotals(totals))

  fragment.append(
    el('p', {
      className: 'admin-note',
      text:
        `Snapshot taken ${formatTimestamp(data?.generatedAt)}. ` +
        `Activity from ${formatTimestamp(totals.firstRequestAt)} to ${formatTimestamp(totals.lastRequestAt)}.`,
    })
  )

  if (!totals.requestCount) {
    fragment.append(el('p', { className: 'admin-note', text: 'No queries have been logged yet.' }))
    container.replaceChildren(fragment)
    return
  }

  const byModel = data.byModel ?? []
  const hasUnknownRates = byModel.some((model) => model.ratesKnown === false)

  fragment.append(
    buildSection(
      'By model',
      buildTable(
        [
          { label: 'Model', key: 'modelId', className: 'admin-cell-mono' },
          { label: 'Calls', key: 'callCount', numeric: true, format: formatInteger },
          { label: 'Input tokens', key: 'inputTokens', numeric: true, format: formatInteger },
          { label: 'Output tokens', key: 'outputTokens', numeric: true, format: formatInteger },
          {
            label: 'Estimated cost',
            key: 'estimatedCostUsd',
            numeric: true,
            format: (value, row) =>
              row.ratesKnown === false ? `${formatCost(value)} *` : formatCost(value),
          },
        ],
        byModel
      ),
      hasUnknownRates
        ? '* No price configured for this model, so its cost is reported as zero.'
        : undefined
    )
  )

  fragment.append(
    buildSection(
      'By pipeline stage',
      buildTable(
        [
          { label: 'Stage', key: 'stage' },
          { label: 'Calls', key: 'callCount', numeric: true, format: formatInteger },
          { label: 'Input tokens', key: 'inputTokens', numeric: true, format: formatInteger },
          { label: 'Output tokens', key: 'outputTokens', numeric: true, format: formatInteger },
        ],
        data.byStage ?? []
      ),
      'Stages are the individual model calls made while answering one question.'
    )
  )

  fragment.append(
    buildSection(
      'By day',
      buildTable(
        [
          { label: 'Day', key: 'day' },
          { label: 'Queries', key: 'requestCount', numeric: true, format: formatInteger },
          { label: 'Input tokens', key: 'inputTokens', numeric: true, format: formatInteger },
          { label: 'Output tokens', key: 'outputTokens', numeric: true, format: formatInteger },
          {
            label: 'Estimated cost',
            key: 'estimatedCostUsd',
            numeric: true,
            format: formatCost,
          },
        ],
        data.daily ?? []
      )
    )
  )

  fragment.append(
    buildSection(
      'By outcome',
      buildTable(
        [
          { label: 'Outcome', key: 'outcome' },
          { label: 'Queries', key: 'requestCount', numeric: true, format: formatInteger },
        ],
        data.byOutcome ?? []
      )
    )
  )

  fragment.append(
    buildSection('Recent questions & answers', buildRecentRequests(data.recentRequests ?? []))
  )

  container.replaceChildren(fragment)
}

/** @type {string | null} */
let activeToken = null

/**
 * @param {string} token
 * @returns {Promise<any>}
 */
async function fetchUsage(token) {
  const response = await fetch(`${API_BASE_URL}/observe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ includeRecent: true, recentLimit: RECENT_LIMIT }),
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.status === 401 || response.status === 403) {
    const error = new Error(payload?.error || 'Unauthorized')
    error.code = 'unauthorized'
    throw error
  }

  if (response.status === 503) {
    const error = new Error(
      payload?.error || 'Admin access is not configured. Set ADMIN_PASSWORD on the server.'
    )
    error.code = 'misconfigured'
    throw error
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`)
  }

  return payload
}

/** @returns {Promise<void>} */
async function populateAdminContent() {
  const container = document.getElementById('admin-content')
  if (!container) return

  if (!activeToken) {
    container.replaceChildren(
      el('p', { className: 'admin-note', text: 'Unlock the console to load usage data.' })
    )
    return
  }

  container.replaceChildren(el('p', { className: 'admin-note', text: 'Loading usage data…' }))

  try {
    const data = await fetchUsage(activeToken)
    renderDashboard(container, data)
  } catch (error) {
    console.error('Error fetching admin data:', error)
    if (error?.code === 'unauthorized') {
      activeToken = null
      clearStoredToken()
      showAuthDialog('Incorrect password or session expired. Please try again.')
      container.replaceChildren(
        el('p', { className: 'admin-note', text: 'Usage data loads once the console is unlocked.' })
      )
      return
    }

    container.replaceChildren(
      el('h1', { className: 'admin-title', text: 'Query usage & cost' }),
      el('p', {
        className: 'admin-error',
        text: `Failed to load admin data: ${error?.message || error}`,
      })
    )
  }
}

/**
 * @param {string} [errorText]
 * @returns {void}
 */
function showAuthDialog(errorText) {
  const dialog = document.getElementById('authDialog')
  const form = document.getElementById('authForm')
  const input = document.getElementById('authPasswordInput')
  const errorMessage = document.getElementById('authErrorMessage')

  if (!(dialog instanceof HTMLDialogElement) || !form || !input || !errorMessage) return

  document.body.classList.add('auth-locked')
  errorMessage.textContent = errorText || 'Incorrect password. Please try again.'
  errorMessage.hidden = !errorText
  errorMessage.classList.toggle('visible', Boolean(errorText))
  input.value = ''

  if (!dialog.open) {
    dialog.showModal()
  }
  input.focus()
}

/** @returns {void} */
function hideAuthDialog() {
  const dialog = document.getElementById('authDialog')
  document.body.classList.remove('auth-locked')
  if (dialog instanceof HTMLDialogElement && dialog.open) {
    dialog.close()
  }
}

/** @returns {void} */
function lockConsole() {
  activeToken = null
  clearStoredToken()
  const container = document.getElementById('admin-content')
  container?.replaceChildren(
    el('p', { className: 'admin-note', text: 'Usage data loads once the console is unlocked.' })
  )
  showAuthDialog()
}

/** @returns {void} */
function initAuthGate() {
  const dialog = document.getElementById('authDialog')
  const form = document.getElementById('authForm')
  const input = document.getElementById('authPasswordInput')
  const errorMessage = document.getElementById('authErrorMessage')

  if (!(dialog instanceof HTMLDialogElement) || !form || !input || !errorMessage) return

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const password = input.value
    if (!password) {
      errorMessage.textContent = 'Enter the admin password.'
      errorMessage.hidden = false
      errorMessage.classList.add('visible')
      input.focus()
      return
    }

    const submitBtn = form.querySelector('[type="submit"]')
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true
    errorMessage.hidden = true
    errorMessage.classList.remove('visible')

    try {
      await fetchUsage(password)
      activeToken = password
      storeToken(password)
      hideAuthDialog()
      await populateAdminContent()
    } catch (error) {
      if (error?.code === 'unauthorized') {
        errorMessage.textContent = 'Incorrect password. Please try again.'
      } else if (error?.code === 'misconfigured') {
        errorMessage.textContent = error.message
      } else {
        errorMessage.textContent = error?.message || 'Could not unlock the console.'
      }
      errorMessage.hidden = false
      errorMessage.classList.add('visible')
      input.value = ''
      input.focus()
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false
    }
  })

  // Prevent dismissing without a valid unlock (Escape would otherwise close).
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
  })

  const remembered = getRememberedToken()
  if (remembered) {
    activeToken = remembered
    populateAdminContent().catch(() => {
      /* populateAdminContent handles UI errors */
    })
    return
  }

  showAuthDialog()
}

const adminContainer = document.getElementById('admin-content')

adminContainer?.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return

  if (event.target.closest('[data-admin-refresh]')) {
    populateAdminContent()
    return
  }

  if (event.target.closest('[data-admin-lock]')) {
    lockConsole()
    return
  }

  const row = event.target.closest('tr.admin-row-expandable')
  if (!row) return
  if (window.getSelection()?.toString()) return
  toggleRowExpansion(row)
})

adminContainer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!(event.target instanceof Element)) return

  const row = event.target.closest('tr.admin-row-expandable')
  if (!row) return

  event.preventDefault()
  toggleRowExpansion(row)
})

initAuthGate()
