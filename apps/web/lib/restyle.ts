/**
 * Run once the page has loaded: when the dashboard is on the page but its stylesheet did not apply
 * (the request failed, or Cloudflare Access answered it with its sign-in page because the session
 * ran out), reload once, which signs in again if that is what is needed. If the page that reload
 * brings is unstyled too, say so on the page instead of reloading again; the viewer's own reload
 * then gets one more automatic try. Self-contained: it runs as an inline script, from its source
 * text.
 */
export function restyle(win: Window): void {
  const doc = win.document
  const root = doc.querySelector('.cmd-root')
  if (root === null) return
  const key = 'cmd-restyle-tried'
  const styled = win.getComputedStyle(root).getPropertyValue('--cmd-surface').trim() !== ''
  try {
    const tried = win.sessionStorage.getItem(key) !== null
    if (styled || tried) win.sessionStorage.removeItem(key)
    if (styled) return
    if (!tried) {
      win.sessionStorage.setItem(key, '1')
      win.location.reload()
      return
    }
  } catch {
    if (styled) return
    // No session storage: no way to tell a first try from a loop, so do not reload.
  }
  const note = doc.createElement('p')
  note.setAttribute('role', 'alert')
  note.textContent = "The page's styles did not load. Reload to try again."
  note.style.cssText =
    'margin:0;padding:12px 16px;background:#fff3cd;color:#3d2f00;font:16px system-ui'
  doc.body.prepend(note)
}

/** The inline script: restyle after the load event, when every stylesheet has loaded or failed. */
export const RESTYLE_SCRIPT = `(function(){var f=${restyle.toString()};if(document.readyState==='complete')f(window);else window.addEventListener('load',function(){f(window)})})()`
