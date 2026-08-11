/**
 * Retrofit Directory Client-side Application Logic
 */

import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm'
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.12/+esm'
import 'https://cdn.jsdelivr.net/npm/@knadh/oat@0.7.1/oat.min.js'

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
  initTextareaActions()
  initCookieConsent()
})

/**
 * Copy/Save buttons, Canned queries, and Backend Integration
 */
function initTextareaActions() {
  const overlay = document.getElementById('processing-overlay')
  const sendBtn = document.getElementById('btnSend')
  const copyChat = document.getElementById('btnCopy')
  const newChat = document.getElementById('btnNew')
  const userInput = document.getElementById('user-input')
  const messagesDiv = document.getElementById('chat-messages')
  let chatHistory = []

  const isLocal =
    window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const API_BASE_URL = isLocal
    ? 'http://localhost:5001/api'
    : 'https://retrofit-directory.org.uk/retrofit'
  const IMAGE_BASE_URL = isLocal
    ? 'http://localhost:5001/api'
    : 'https://retrofit-directory.org.uk/retrofit'

  async function sendMessage(prompt = '') {
    const message = prompt || userInput.value.trim()
    if (!message) return

    // Add User Message to UI and chat history
    chatHistory.push({ role: 'user', content: [{ query: message }] })
    appendMessage('user', message)
    userInput.value = ''
    userInput.placeholder = 'Ask a follow up or new question...'
    overlay.style.display = 'block'

    try {
      const response = await fetch(`${API_BASE_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory }),
      })

      const data = await response.json()
      console.log('API Response:', data)
      overlay.style.display = 'none'

      if (data.error) throw new Error(data.error)
      // Add AI response to history
      chatHistory.push({ role: 'assistant', content: [{ text: data.response }] })
      // Render the AI response as Markdown
      appendMessage('ai', data.response, data.sources)
    } catch (err) {
      overlay.style.display = 'none'
      appendMessage('ai', `**Error:** ${err.message}`)
    }
  }

  function appendMessage(sender, text, sources = []) {
    const msgDiv = document.createElement('div')
    msgDiv.className = `message ${sender}-message`

    // 1. Convert Markdown text to HTML
    const renderer = new marked.Renderer()
    renderer.image = function (token) {
      let finalHref = token.href
      // If the path is relative (starts with /images/), prepend the base URL
      if (token.href && token.href.startsWith('/images/')) {
        finalHref = `${IMAGE_BASE_URL}${token.href}`
      }
      return `<img src="${finalHref}" alt="${token.text || ''}" title="${token.title || ''}" class="chat-image" />`
    }
    marked.use({ renderer })
    let htmlContent = marked.parse(text)

    // 2. Append Sources if they exist. Backend sends { name, url }; only http(s) urls are linked.
    if (sources.length > 0) {
      htmlContent += `<div class="source-header">Sources:</div>`
      sources.forEach((source) => {
        const name = typeof source?.name === 'string' ? source.name.trim() : ''
        const url = typeof source?.url === 'string' ? source.url.trim() : ''
        if (!name && !url) return
        const label = name || url
        if (/^https?:\/\//i.test(url)) {
          htmlContent += `<a href="${url}" target="_blank" rel="noopener noreferrer" class="source-link">📖 ${label}</a>`
        } else {
          htmlContent += `<span class="source-link">📖 ${label}</span>`
        }
      })
    }
    const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'class', 'target', 'rel']
    msgDiv.innerHTML = DOMPurify.sanitize(htmlContent, { ALLOWED_ATTR })

    // Remove any previous spacer
    const oldSpacer = messagesDiv.querySelector('.chat-spacer')
    if (oldSpacer) oldSpacer.remove()

    messagesDiv.appendChild(msgDiv)

    if (sender === 'user') {
      // Add a spacer so there is always enough overflow to scroll
      // the user message to the very top of the visible area
      const spacer = document.createElement('div')
      spacer.className = 'chat-spacer'
      spacer.style.height = messagesDiv.clientHeight + 'px'
      messagesDiv.appendChild(spacer)

      const pageY = window.scrollY
      msgDiv.scrollIntoView({ block: 'start' })
      window.scrollTo(0, pageY)
    }
  }

  // Event listeners
  sendBtn.addEventListener('click', () => sendMessage())
  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage()
  })

  copyChat.addEventListener('click', () => copyChatWindowToClipboard())

  newChat.addEventListener('click', () => {
    chatHistory = []
    messagesDiv.innerHTML = ''
    userInput.placeholder = 'Ask anything about retrofit...'
  })

  // Select all the suggestion buttons and add the listener
  document.querySelectorAll('.action-btn').forEach((button) => {
    button.addEventListener('click', () => {
      sendMessage(button.textContent.trim())
    })
  })

  function copyChatWindowToClipboard() {
    const chatContent = messagesDiv.innerText
    navigator.clipboard.writeText(chatContent).then(
      () => showToast('Chat copied to clipboard'),
      (err) => showToast(`Failed to copy chat: ${err}`, 'error', { duration: 5000 })
    )
  }
}

/**
 * Cookie Popup Consent Management
 */
function initCookieConsent() {
  const cookiePopup = document.getElementById('cookiePopup')
  const btnAccept = document.getElementById('acceptCookiesBtn')

  if (!cookiePopup || !btnAccept) return

  const consentGiven = localStorage.getItem('retrofit_cookie_consent')
  if (!consentGiven) {
    // Show popup after slight delay
    setTimeout(() => {
      cookiePopup.classList.add('active')
    }, 800)
  }

  btnAccept.addEventListener('click', () => {
    localStorage.setItem('retrofit_cookie_consent', 'true')
    cookiePopup.classList.remove('active')

    // Delay slightly so the popup close animation completes before showing feedback.
    setTimeout(() => {
      showToast('Essential cookie policy accepted.')
    }, 150)
  })
}
