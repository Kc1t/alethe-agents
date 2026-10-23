import { applyBootAppearance } from './lib/bootAppearance'

if (import.meta.env.DEV) {
  document.title = '(DEV) Alethe'
}

// Mark the platform as soon as the bundled entry starts evaluating, before
// styles and React, so the first paint already leaves room for the macOS
// traffic lights (see TitleBar.module.css).
document.documentElement.dataset.platform = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? 'macos'
  : 'other'

// Paint the startup screen with the last known theme; App.tsx takes over after hydration.
applyBootAppearance()
