/**
 * Admin dashboard for the Retrofit Directory query service.
 *
 * Fetches the usage summary from POST /api/observe and renders it as formatted
 * tables inside #admin-content. Also owns the client-side password gate.
 *
 * All cell content is written with textContent rather than innerHTML: the
 * recent-query rows contain user-submitted text and must never be parsed as
 * markup.
 */

const PASSWORD = 'retrofit-admin' // Intentionally simple deterrent only.
const RECENT_LIMIT = 100

// A successful unlock is remembered so the password is not required on every
// visit. Only a timestamp is stored, never the password itself, and it lapses
// after the period below so an unattended browser does not stay open forever.
const UNLOCK_STORAGE_KEY = 'retrofit_admin_unlocked_at'
const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const isLocal = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
// Prefer same-origin API on whichever host serves the page (apex or www).
const API_BASE_URL = isLocal
  ? 'http://localhost:5001/api'
  : `${window.location.origin}/retrofit`

const integerFormatter = new Intl.NumberFormat('en-GB')
const costFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})
// Cheap models can cost a few hundredths of a cent, which 4 decimals would
// round away to zero; fall back to this only for such small values.
const smallCostFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
})
const SMALL_COST_THRESHOLD_USD = 0.001

/**
 * Read the stored unlock time. Storage access can throw when cookies/storage
 * are blocked, in which case the gate simply falls back to asking every time.
 * @returns {number | null} Epoch milliseconds, or null if absent/unreadable.
 */
function readUnlockTime() {
  try {
    const raw = window.localStorage.getItem(UNLOCK_STORAGE_KEY)
    if (!raw) return null
    const timestamp = Number(raw)
    return Number.isFinite(timestamp) ? timestamp : null
  } catch {
    return null
  }
}

/** @returns {void} */
function rememberUnlock() {
  try {
    window.localStorage.setItem(UNLOCK_STORAGE_KEY, String(Date.now()))
  } catch {
    // Storage unavailable; the unlock just will not persist.
  }
}

/** @returns {void} */
function forgetUnlock() {
  try {
    window.localStorage.removeItem(UNLOCK_STORAGE_KEY)
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/**
 * Whether a previous unlock is still valid. An expired record is discarded so
 * it cannot linger in storage.
 * @returns {boolean}
 */
function isUnlockRemembered() {
  const unlockedAt = readUnlockTime()
  if (unlockedAt === null) return false

  // A clock change could put the stored time in the future; treat that as stale.
  const age = Date.now() - unlockedAt
  if (age < 0 || age > UNLOCK_TTL_MS) {
    forgetUnlock()
    return false
  }
  return true
}

/**
 * Create an element with optional class, text and attributes.
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

/**
 * Format a count, showing a dash for absent values. Null is meaningful here:
 * an out-of-scope query never reaches the database, so it has no row count.
 * @param {unknown} value
 * @returns {string}
 */
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

/**
 * Render an ISO timestamp as a local date/time, tolerating null.
 * @param {string | null | undefined} isoTimestamp
 * @returns {string}
 */
function formatTimestamp(isoTimestamp) {
  if (!isoTimestamp) return '—'
  const date = new Date(isoTimestamp)
  return Number.isNaN(date.valueOf()) ? String(isoTimestamp) : date.toLocaleString('en-GB')
}

/**
 * Build a table from a column specification.
 *
 * `clamp` columns put their text in an inner element, because the CSS used to
 * truncate long values cannot be applied to a <td> without breaking the table
 * layout. Cells carry no `title` tooltip: clamped text is revealed by expanding
 * the row, and every other column either wraps or is short enough to read in
 * full, so a tooltip would only ever restate the visible text.
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
            // Hint label; shown by CSS only once the text is known to overflow.
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
 * Wrap content in a titled section, with an optional note under the heading.
 * @param {string} title
 * @param {Node} content
 * @param {string} [note]
 * @returns {HTMLElement}
 */
function buildSection(title, content, note) {
  const children = [el('h4', { className: 'admin-section-title', text: title })]
  if (note) children.push(el('p', { className: 'admin-note', text: note }))
  children.push(content)
  return el('section', { className: 'admin-section' }, children)
}

/**
 * Headline totals as a row of stat cards.
 * @param {any} totals
 * @returns {HTMLElement}
 */
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

/**
 * Toggle the expanded state of one recent-request row.
 * @param {HTMLElement} row
 * @returns {void}
 */
function toggleRowExpansion(row) {
  const expanded = row.classList.toggle('is-expanded')
  row.setAttribute('aria-expanded', expanded ? 'true' : 'false')
}

/**
 * Flag clamped cells whose text is actually cut off, so the "Show more" hint
 * only appears where there is more to see.
 *
 * Overflow can only be measured once the table is laid out, hence the frame
 * delay. If measurement is unavailable the hint is simply omitted; rows stay
 * expandable either way.
 * @param {HTMLElement} table
 * @returns {void}
 */
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

/**
 * Scrollable list of recent questions and the answers returned.
 * @param {any[]} recentRequests
 * @returns {HTMLElement}
 */
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
        // Show the context-resolved question, flagging where it was rewritten.
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

  // Rows expand to reveal the full question and answer. Focusable so the
  // keyboard can reach them, since there is no button to tab to.
  for (const row of table.querySelectorAll('tbody tr')) {
    row.classList.add('admin-row-expandable')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-expanded', 'false')
  }

  markOverflowingCells(table)
  return table
}

/**
 * Replace the contents of the admin container with the rendered dashboard.
 * @param {HTMLElement} container
 * @param {any} data Usage summary from /api/observe.
 * @returns {void}
 */
function renderDashboard(container, data) {
  const fragment = document.createDocumentFragment()

  const refreshButton = el('button', {
    className: 'btn-small btn-small-outline',
    text: 'Refresh',
    attrs: { type: 'button', 'data-admin-refresh': 'true' },
  })

  fragment.append(
    el('div', { className: 'admin-header' }, [
      el('h3', { className: 'admin-title', text: 'Query usage & cost' }),
      refreshButton,
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

/**
 * Fetch the usage summary and render it into #admin-content.
 * @returns {Promise<void>}
 */
async function populateAdminContent() {
  const container = document.getElementById('admin-content')
  if (!container) return

  container.replaceChildren(el('p', { className: 'admin-note', text: 'Loading usage data…' }))

  try {
    const response = await fetch(`${API_BASE_URL}/observe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeRecent: true, recentLimit: RECENT_LIMIT }),
    })

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`)
    }

    renderDashboard(container, await response.json())
  } catch (error) {
    console.error('Error fetching admin data:', error)
    container.replaceChildren(
      el('h3', { className: 'admin-title', text: 'Query usage & cost' }),
      el('p', {
        className: 'admin-error',
        text: `Failed to load admin data: ${error?.message || error}`,
      })
    )
  }
}

/**
 * Client-side password gate. A deterrent for casual visitors only; it does not
 * protect /api/observe, which is enforced server-side or not at all.
 * @returns {void}
 */
function initAuthGate() {
  const overlay = document.getElementById('authModalOverlay')
  const input = document.getElementById('authPasswordInput')
  const submitBtn = document.getElementById('authSubmitBtn')
  const errorMessage = document.getElementById('authErrorMessage')

  if (!overlay || !input || !submitBtn || !errorMessage) return

  const unlock = () => {
    document.body.classList.remove('auth-locked')
    overlay.remove()
    populateAdminContent()
  }

  // Returning visitor within the remembered window: skip the prompt entirely.
  // The overlay starts hidden in the markup so it never flashes into view.
  if (isUnlockRemembered()) {
    unlock()
    return
  }

  const attemptUnlock = () => {
    if (input.value !== PASSWORD) {
      errorMessage.classList.add('visible')
      input.value = ''
      input.focus()
      return
    }

    rememberUnlock()
    unlock()
  }

  document.body.classList.add('auth-locked')
  overlay.hidden = false
  input.focus()

  submitBtn.addEventListener('click', attemptUnlock)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attemptUnlock()
  })
}

// Content is rebuilt on every render, so listen at the container instead of
// binding to elements that will be replaced.
const adminContainer = document.getElementById('admin-content')

adminContainer?.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return

  if (event.target.closest('[data-admin-refresh]')) {
    populateAdminContent()
    return
  }

  const row = event.target.closest('tr.admin-row-expandable')
  if (!row) return

  // Do not collapse a row the user was only dragging across to copy text.
  if (window.getSelection()?.toString()) return

  toggleRowExpansion(row)
})

adminContainer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!(event.target instanceof Element)) return

  const row = event.target.closest('tr.admin-row-expandable')
  if (!row) return

  event.preventDefault() // Space would otherwise scroll the page.
  toggleRowExpansion(row)
})

initAuthGate()
