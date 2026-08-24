/**
 * Mobile navigation toggle
 */
function initMobileNav() {
  const toggleBtn = document.getElementById('mobileNavToggle')
  const navMenu = document.getElementById('navMenu')
  const siteNav = document.getElementById('siteNav')

  if (!toggleBtn || !navMenu) return

  const setOpen = (open) => {
    navMenu.classList.toggle('open', open)
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    toggleBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
    if (siteNav) siteNav.classList.toggle('is-open', open)
  }

  setOpen(false)

  toggleBtn.addEventListener('click', () => {
    const willOpen = !navMenu.classList.contains('open')
    setOpen(willOpen)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navMenu.classList.contains('open')) {
      setOpen(false)
      toggleBtn.focus()
    }
  })

  navMenu.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) {
      setOpen(false)
    }
  })

  document.addEventListener('click', (event) => {
    if (!navMenu.classList.contains('open')) return
    if (!(event.target instanceof Node)) return
    const within =
      navMenu.contains(event.target) ||
      toggleBtn.contains(event.target) ||
      (siteNav && siteNav.contains(event.target))
    if (!within) setOpen(false)
  })
}

initMobileNav()
