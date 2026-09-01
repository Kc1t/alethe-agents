if (import.meta.env.DEV) {
  document.title = '(DEV) Alethe'
}

// Mark the platform as soon as the bundled entry starts evaluating, before
// styles and React, to avoid an opaque first paint behind rounded macOS window
// corners. App.tsx confirms the value later; see reset.css.
document.documentElement.dataset.platform = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? 'macos'
  : 'other'
