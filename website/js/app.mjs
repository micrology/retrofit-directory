/**
 * Retrofit Directory client-side application logic
 */

import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm'
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.12/+esm'
import 'https://cdn.jsdelivr.net/npm/@knadh/oat@0.7.1/oat.min.js'

const SUGGESTION_PROMPTS = [
  "What is 'retrofit'?",
  'How many organisations related to retrofit are located in Bristol?',
  'Is there an architect near Portsmouth?',
  'What is PAS2035?',
]

function showToast(message, variant = 'success', options = {}) {
  if (!window.ot || typeof window.ot.toast !== 'function') return

  window.ot.toast(message, '', {
    variant,
    duration: 3000,
    placement: 'top-center',
    ...options,
  })
}

document.addEventListener('DOMContentLoaded', () => {
  initChat()
  initCookieNotice()
})

/**
 * Chat composer, canned queries, and backend integration.
 */
function initChat() {
  const form = document.getElementById('chat-form')
  const statusEl = document.getElementById('chat-status')
  const sendBtn = document.getElementById('btnSend')
  const copyChat = document.getElementById('btnCopy')
  const newChat = document.getElementById('btnNew')
  const userInput = document.getElementById('user-input')
  const messagesDiv = document.getElementById('chat-messages')

  if (!form || !sendBtn || !copyChat || !newChat || !userInput || !messagesDiv) return

  let chatHistory = []
  let isSending = false

  const isLocal =
    window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const API_BASE_URL = isLocal
    ? 'http://localhost:5001/api'
    : `${window.location.origin}/retrofit`
  const IMAGE_BASE_URL = API_BASE_URL

  /** @param {boolean} busy */
  function setBusy(busy) {
    isSending = busy
    sendBtn.disabled = busy
    userInput.disabled = busy
    form.setAttribute('aria-busy', busy ? 'true' : 'false')
    if (statusEl) {
      statusEl.hidden = !busy
      statusEl.textContent = busy ? 'Working on your question…' : ''
    }
  }

  function renderSuggestions() {
    messagesDiv.replaceChildren()

    const prompt = document.createElement('p')
    prompt.className = 'chat-prompt'
    prompt.id = 'chat-suggestions-label'
    prompt.textContent = 'Try one of these, or type your own question:'

    const list = document.createElement('div')
    list.className = 'action-buttons-row'
    list.setAttribute('role', 'group')
    list.setAttribute('aria-labelledby', 'chat-suggestions-label')

    for (const text of SUGGESTION_PROMPTS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'action-btn'
      button.textContent = text
      button.addEventListener('click', () => {
        userInput.value = text
        sendMessage(text)
      })
      list.append(button)
    }

    messagesDiv.append(prompt, list)
  }

  /**
   * @param {'user' | 'ai'} sender
   * @param {string} text
   * @param {Array<{ name?: string, url?: string }>} [sources]
   */
  function appendMessage(sender, text, sources = []) {
    messagesDiv.querySelector('.chat-prompt')?.remove()
    messagesDiv.querySelector('.action-buttons-row')?.remove()

    const msgDiv = document.createElement('div')
    msgDiv.className = `message ${sender}-message`
    msgDiv.setAttribute('role', sender === 'ai' ? 'status' : 'group')

    const renderer = new marked.Renderer()
    renderer.image = function (token) {
      let finalHref = token.href
      if (token.href && token.href.startsWith('/images/')) {
        finalHref = `${IMAGE_BASE_URL}${token.href}`
      }
      const alt = DOMPurify.sanitize(token.text || '', { ALLOWED_TAGS: [] })
      const title = DOMPurify.sanitize(token.title || '', { ALLOWED_TAGS: [] })
      return `<img src="${finalHref}" alt="${alt}" title="${title}" class="chat-image" loading="lazy" />`
    }
    marked.use({ renderer })
    let htmlContent = marked.parse(text)

    if (sources.length > 0) {
      htmlContent += `<div class="source-header">Sources</div><ul class="source-list">`
      sources.forEach((source) => {
        const name = typeof source?.name === 'string' ? source.name.trim() : ''
        const url = typeof source?.url === 'string' ? source.url.trim() : ''
        if (!name && !url) return
        const label = name || url
        const safeLabel = DOMPurify.sanitize(label, { ALLOWED_TAGS: [] })
        if (/^https?:\/\//i.test(url)) {
          htmlContent += `<li><a href="${url}" target="_blank" rel="noopener noreferrer" class="source-link">${safeLabel}</a></li>`
        } else {
          htmlContent += `<li><span class="source-link source-link--plain">${safeLabel}</span></li>`
        }
      })
      htmlContent += `</ul>`
    }

    const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'loading']
    msgDiv.innerHTML = DOMPurify.sanitize(htmlContent, { ALLOWED_ATTR })

    const oldSpacer = messagesDiv.querySelector('.chat-spacer')
    if (oldSpacer) oldSpacer.remove()

    messagesDiv.appendChild(msgDiv)

    if (sender === 'user') {
      const spacer = document.createElement('div')
      spacer.className = 'chat-spacer'
      spacer.setAttribute('aria-hidden', 'true')
      spacer.style.height = `${messagesDiv.clientHeight}px`
      messagesDiv.appendChild(spacer)

      const pageY = window.scrollY
      msgDiv.scrollIntoView({ block: 'start' })
      window.scrollTo(0, pageY)
    } else {
      msgDiv.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  /**
   * @param {string} [prompt]
   * @returns {Promise<void>}
   */
  async function sendMessage(prompt = '') {
    if (isSending) return

    const message = (prompt || userInput.value).trim()
    if (!message) return

    chatHistory.push({ role: 'user', content: [{ query: message }] })
    appendMessage('user', message)
    userInput.value = ''
    userInput.placeholder = 'Ask a follow-up or a new question…'
    setBusy(true)

    try {
      const response = await fetch(`${API_BASE_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory }),
      })

      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }

      if (!response.ok) {
        const detail =
          (data && (data.error || data.message)) || `Request failed (${response.status})`
        throw new Error(detail)
      }

      if (!data || typeof data.response !== 'string') {
        throw new Error('The assistant returned an unexpected response.')
      }

      if (data.error) throw new Error(data.error)

      chatHistory.push({ role: 'assistant', content: [{ text: data.response }] })
      appendMessage('ai', data.response, Array.isArray(data.sources) ? data.sources : [])
    } catch (err) {
      chatHistory.pop()
      appendMessage('ai', `**Error:** ${err.message || 'Something went wrong.'}`)
    } finally {
      setBusy(false)
      userInput.focus()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    sendMessage()
  })

  copyChat.addEventListener('click', () => {
    const chatContent = messagesDiv.innerText.trim()
    if (!chatContent) {
      showToast('Nothing to copy yet', 'warning')
      return
    }
    navigator.clipboard.writeText(chatContent).then(
      () => showToast('Chat copied to clipboard'),
      (err) => showToast(`Failed to copy chat: ${err}`, 'error', { duration: 5000 })
    )
  })

  newChat.addEventListener('click', () => {
    if (isSending) return
    chatHistory = []
    userInput.placeholder = 'Ask anything about retrofit…'
    renderSuggestions()
    userInput.focus()
  })

  renderSuggestions()
}

/**
 * Privacy notice: only essential storage is used. Prefer a quiet dialog.
 */
function initCookieNotice() {
  const dialog = document.getElementById('privacyDialog')
  const btnAccept = document.getElementById('acceptCookiesBtn')

  if (!(dialog instanceof HTMLDialogElement) || !btnAccept) return

  const consentGiven = localStorage.getItem('retrofit_cookie_consent')
  if (consentGiven) return

  if (typeof dialog.show === 'function') {
    dialog.show()
  } else {
    dialog.setAttribute('open', '')
  }

  btnAccept.addEventListener('click', () => {
    localStorage.setItem('retrofit_cookie_consent', 'true')
    dialog.close()
  })
}
