/**
 * Mobile Navigation Toggle
 */
function initMobileNav() {
  const toggleBtn = document.getElementById('mobileNavToggle')
  const navMenu = document.getElementById('navMenu')

  if (toggleBtn && navMenu) {
    toggleBtn.addEventListener('click', () => {
      navMenu.classList.toggle('open')
      const isOpen = navMenu.classList.contains('open')
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    })
  }
}
initMobileNav()
