# Frontend

- A new screen ships with an end-to-end test in the same change, walking the flow the way a person
  walks it.
- The server is the authority; client-side validation is for responsiveness, not truth.
- Use the project's design-system primitive before hand-building a button, table or dialog.
- Server data goes through the app's data layer — no ad-hoc HTTP call inside a component.
- Do not fetch in a mount effect; effects are for real side effects (focus, subscriptions), each
  with a line saying why.
- Componentize: screens assembled from small components, logic in hooks, no god component.
- Accessibility and responsiveness are not extras: no horizontal overflow at standard widths, and
  every interactive element carries a label.
- The contents of a modal, tab or accordion load when it opens, not when the page mounts — confirm
  in the network tab that the request waits for the click. If the page needs part of that data, give
  it its own light endpoint.
- Open it in a real browser and interact — filter, paginate, empty, loading — before calling it
  done. For a visual bug, read the computed style; it beats a screenshot.
- The screen shows the real state: loading, empty and error too.
- Visible copy and error-message extraction live in one place.
