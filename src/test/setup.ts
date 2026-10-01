import '@testing-library/jest-dom/vitest'

// jsdom omits the CSS Font Loading API, which the terminal hook calls before its first cell
// measurement. Without this the hook throws on mount, which is a gap in the test environment, not
// in the hook — every supported webview implements `document.fonts`.
if (typeof document !== 'undefined' && !document.fonts) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: () => Promise.resolve([]), check: () => true },
  })
}
