/**
 * Helpers that drive the git pipeline through real CLICK/TYPING in the
 * UI — not via `window.__ALETHE_E2E__` (which only calls store/API
 * actions directly). Explicit request from the owner after seeing, live, real
 * bugs that a hook-driven test would NEVER catch:
 *
 * 1. The folder field (`New project`/`New terminal`) has a
 *    "Browse" button that opens Windows' NATIVE folder picker — outside the
 *    webview, WebDriver can't see or close that window. The
 *    text field next to it accepts direct typing (a normal `onChange`) —
 *    ALWAYS type the path, NEVER click "Browse".
 * 2. The project Settings' "Agents" tab has TWO different agent
 *    selectors on the same screen: the automatic worktree toggle and,
 *    further down, "CONFLICT RESOLUTION AGENT" — cards with the SAME
 *    labels ("OpenCode", "Mimo" etc.) as the cards in the "New
 *    terminal" modal. A loose text selector (`button*=OpenCode`) can find the
 *    wrong card if the settings modal hasn't really closed
 *    yet — that's how a previous test "selected Mimo" by clicking
 *    the wrong card with no error at all. Because of this: (a) every click here uses
 *    `markScreenshotAndClick` — visual PROOF (red dot + screenshot) of
 *    which element was resolved, no exceptions; (b) every modal switch
 *    actively waits for the PREVIOUS modal to disappear from the DOM before continuing; (c)
 *    the "New terminal" agent selection is scoped inside the container
 *    of that specific modal (found via `h2*=Novo terminal`), never a
 *    loose search on the whole page.
 *
 * `__ALETHE_E2E_QUERY__` (see `src/lib/e2eHooks.ts`) is used only to READ
 * IDs the UI already created (real clicks don't return IDs to the test) — never
 * to trigger the creation itself.
 */
import { captureScreenshot, markScreenshotAndClick } from './screenshot'
import { withIdleScreenshot } from './uiKit'

type QueryWindow = {
  __ALETHE_E2E_QUERY__?: {
    findProjectIdByName: (name: string) => string | null
    findLatestTerminal: (
      projectId: string,
    ) => { ptyId: string; worktreeAgentId: string | null } | null
    getConflictAgentProvider: (projectId: string) => string | null
  }
}

/** The conflict agent card (`EditProjectAgentSettings.tsx`) has no
 *  `aria-pressed` (just a conditional icon, not checkable without depending on a
 *  hashed CSS class) — the only reliable verification is reading the real value
 *  persisted in the store after the click. */
export async function getConflictAgentProvider(projectId: string): Promise<string | null> {
  return browser.execute((id) => {
    const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
    if (!query) throw new Error('__ALETHE_E2E_QUERY__ is not ready yet')
    return query.getConflictAgentProvider(id)
  }, projectId) as unknown as Promise<string | null>
}

let clickCounter = 0
function nextShotName(label: string): string {
  clickCounter += 1
  return `git-pipeline--${String(clickCounter).padStart(2, '0')}-${label}`
}

export async function findProjectId(name: string): Promise<string> {
  const id = await browser.execute((projectName) => {
    const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
    if (!query) throw new Error('__ALETHE_E2E_QUERY__ is not ready yet')
    return query.findProjectIdByName(projectName)
  }, name)
  if (!id) throw new Error(`findProjectId: project "${name}" not found in the store`)
  return id as unknown as string
}

/** The project's most recent terminal — the one a sequence of real clicks
 *  just opened. Polls because the PTY can take a moment to
 *  come up after clicking "Open <Agent>". */
export async function findLatestTerminal(
  projectId: string,
): Promise<{ ptyId: string; worktreeAgentId: string | null }> {
  let result: { ptyId: string; worktreeAgentId: string | null } | null = null
  await browser.waitUntil(
    async () => {
      result = (await browser.execute((id) => {
        const query = (window as unknown as QueryWindow).__ALETHE_E2E_QUERY__
        if (!query) throw new Error('__ALETHE_E2E_QUERY__ is not ready yet')
        return query.findLatestTerminal(id)
      }, projectId)) as unknown as { ptyId: string; worktreeAgentId: string | null } | null
      return result !== null
    },
    {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `no terminal showed up for project ${projectId}`,
    },
  )
  return result!
}

/** Waits until no Radix `role="dialog"` is on screen anymore — used after
 *  closing/saving any modal, before trusting that the next screen
 *  (sidebar, another modal) is free for interaction. */
async function waitNoDialogOpen(timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => !(await $('[role="dialog"]').isExisting()), {
    timeout,
    timeoutMsg: 'a modal stayed open longer than expected',
  })
}

/** Creates a project via the real UI: types name + folder (NEVER clicks "Browse"). */
export async function createProjectViaUi(name: string, folderPath: string): Promise<void> {
  const nameInput = await $('input[placeholder="Ex: Site novo, Cliente X..."]')
  await nameInput.waitForDisplayed({ timeout: 15_000 })
  await nameInput.setValue(name)

  const pathInput = await $('input[placeholder="Escolha a pasta do projeto"]')
  await pathInput.setValue(folderPath)
  if ((await pathInput.getValue()) !== folderPath) {
    throw new Error('createProjectViaUi: the folder field did not receive the typed value')
  }

  const createButton = await $('button*=Criar projeto e abrir terminal')
  await createButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(createButton, nextShotName('criar-projeto'))

  const sidebarEntry = await $(`span[title="${name}"]`)
  await sidebarEntry.waitForDisplayed({ timeout: 10_000 })
}

/** Closes the "New terminal" modal that opens on its own right after
 *  creating a project (`OnboardingModal`/`NewProjectModal`'s `finish()`/`submit()`) — without
 *  interacting with it, so we can go configure git/worktree first. */
export async function cancelAutoOpenedNewTerminalModal(): Promise<void> {
  const cancelButton = await $('button*=Cancelar')
  if (await cancelButton.isExisting()) {
    await markScreenshotAndClick(cancelButton, nextShotName('cancelar-novo-terminal-auto'))
    await waitNoDialogOpen()
  }
}

/** Opens the project's "Settings…" (via the "More actions" menu → menu item) and
 *  goes to the "Agents" tab, where the `git init` banner lives, the automatic
 *  worktree toggle, and (further down, UNRELATED to this flow) the
 *  conflict resolution agent selector. */
async function openProjectAgentsSettings(): Promise<void> {
  const moreActions = await $('[aria-label="Mais ações"]')
  await moreActions.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(moreActions, nextShotName('abrir-menu-mais-acoes'))

  const settingsItem = await $('button*=Configurações')
  await settingsItem.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(settingsItem, nextShotName('abrir-configuracoes-projeto'))

  const agentsTab = await $('button*=Agentes')
  await agentsTab.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(agentsTab, nextShotName('aba-agentes'))
}

/** Closes the project Settings modal via the X, and waits for it to actually
 *  disappear — never proceeds assuming it closed.
 *  SCOPED to the open `[role="dialog"]`: a loose `[aria-label="Fechar"]`
 *  also matches the button that closes the WHOLE APP WINDOW in the topbar (same
 *  aria-label!) — a real bug that was almost caused live, the app only
 *  didn't close because the modal overlay happened to block the click. */
async function closeProjectSettings(): Promise<void> {
  const closeButton = await $('[role="dialog"] button[aria-label="Fechar"]')
  if (await closeButton.isExisting()) {
    await markScreenshotAndClick(closeButton, nextShotName('fechar-configuracoes-projeto'))
  }
  await waitNoDialogOpen()
}

/**
 * Clicks a button that triggers a native `confirm()` and accepts the dialog — with a
 * second click attempt if the alert doesn't appear in time (flake
 * confirmed live: the marker proved the click target was correct,
 * but sometimes the click doesn't register in time for the `confirm()` to arrive).
 */
async function clickAndAcceptConfirm(selector: string, shotLabel: string): Promise<void> {
  const button = await $(selector)
  await button.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(button, nextShotName(shotLabel))

  let alertAppeared = await browser
    .waitUntil(async () => (await browser.getAlertText().catch(() => null)) !== null, {
      timeout: 4_000,
      interval: 300,
    })
    .catch(() => false)
  if (!alertAppeared) {
    // Explicit request from the owner: if something stays unresolved for more than 5s,
    // capture the screen state BEFORE continuing — even if the second
    // attempt also fails, we're left with a screenshot of the exact moment it hung.
    await withIdleScreenshot(
      `${shotLabel}-esperando-confirm`,
      async () => {
        const retryButton = await $(selector)
        if (await retryButton.isExisting()) {
          await markScreenshotAndClick(retryButton, nextShotName(`${shotLabel}-retry`))
        }
        alertAppeared = await browser.waitUntil(
          async () => (await browser.getAlertText().catch(() => null)) !== null,
          {
            timeout: 6_000,
            interval: 300,
            timeoutMsg: `confirm() never appeared for "${selector}" (2 attempts)`,
          },
        )
      },
      5_000,
    )
  }
  await browser.acceptAlert()
}

/** Runs `git init` in the project's folder through the real UI banner —
 *  accepts the browser's native `confirm()` (this one WebDriver CAN
 *  automate via `acceptAlert()`; unlike the OS's native folder picker,
 *  which it can't). Verifying that `.git` really exists is the
 *  caller's responsibility, by reading the disk directly (`hasRealGitDir`). */
export async function initGitViaUi(): Promise<void> {
  await openProjectAgentsSettings()

  // The banner only exists if the folder is NOT already a Git repo — if a
  // real agent (e.g. OpenCode) already ran `git init` on its own when it started up
  // in the folder before this step (confirmed live: it happens), the banner doesn't even
  // appear. It's not an error, the folder is just already ready — proceeds without
  // trying to click anything.
  const initButton = await $('button*=Inicializar repositório Git')
  if (!(await initButton.isExisting())) {
    await closeProjectSettings()
    return
  }

  try {
    await clickAndAcceptConfirm('button*=Inicializar repositório Git', 'inicializar-git')
  } catch (err) {
    // Real race condition observed live (2 consecutive runs): the button exists
    // at the time of the check, but the `confirm()` never actually appears to
    // WebDriver — and when that happens, the banner has already disappeared on its own (the
    // component's `hasGit` check ran ahead of the click). Instead
    // of hanging the test, treat it as equivalent to the "banner never
    // existed" case (same reasoning as the comment above) — this function's
    // goal is only "folder became a git repo", and whoever really verifies that is
    // always the caller, reading the disk directly, never this helper.
    if (await $('button*=Inicializar repositório Git').isExisting()) throw err
  }

  await closeProjectSettings()
}

export type MergePostAction = 'relocateToNewBranch' | 'relocateKeepSession' | 'closeTerminal'

/**
 * Configures the "Agents" tab (selects the conflict resolution agent
 * via the correct card, turns on "Automatic agent isolation", clicks "Migrate
 * existing terminals now") and the "Merge" tab (agent's post-merge action),
 * in that order, in the SAME open modal — this is how the owner showed the
 * real procedure live: everything configured before a single final "Save".
 *
 * The agent card selector here is `button*=<label>` INSIDE the already-active
 * Agents tab — the same collision concern as the "New terminal" modal
 * (repeated labels), but since only one Radix modal stays open at a time
 * (confirmed: `waitNoDialogOpen` before opening any new modal), there's
 * no need to scope by container here — just make sure no other modal
 * is on top.
 */
/** Clicks "Save" in the Settings modal and waits for it to actually close. */
async function saveProjectSettings(): Promise<void> {
  const saveButton = await $('button*=Salvar')
  await saveButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(saveButton, nextShotName('salvar-configuracoes-projeto'))
  // "Save" closes the modal on its own — but never assume that without checking: it's
  // exactly the kind of race condition that made a previous test collide with the
  // "conflict resolution agent" card (same tab, further down, with
  // agent labels identical to those in the "New terminal" modal).
  await waitNoDialogOpen()
}

/**
 * PHASE 1: selects the conflict resolution agent and turns on "Automatic
 * agent isolation", and SAVES — needs to be truly persisted
 * before Phase 2 (explicit request from the owner: "to migrate the terminals you
 * have to save the automatic isolation first and then go back to the
 * setting" — migrating against a not-yet-saved toggle would be testing
 * an inconsistent state).
 */
export async function selectConflictAgentAndAutoWorktreeViaUi(
  projectId: string,
  conflictAgentLabel: string,
  modelSearchTerm?: string,
): Promise<void> {
  await openProjectAgentsSettings()

  // `waitForClickable` sometimes gives a false negative here even with the card
  // visibly normal in the screenshot (same class of false negative already seen
  // in the dropdown click, before it turned out to be the real pointer-events bug) —
  // doesn't block the whole wait on this, tries the actual click anyway
  // (WebDriver's `click()` command does its own check, sometimes
  // less conservative than the pre-check).
  const conflictAgentCard = await $(`button*=${conflictAgentLabel}`)
  await withIdleScreenshot('aguardando-card-agente-conflito-clicavel', () =>
    conflictAgentCard.waitForClickable({ timeout: 10_000 }).catch(() => {}),
  )
  // Both `waitForClickable` AND `.click()` itself have already given false negatives here
  // on different runs (confirmed live: the same click passed cleanly
  // on 5 previous runs and failed with "element not interactable" only on this one,
  // with no app change between them) — retry with a short pause, same
  // pattern already used in `clickByText` for the portal menu flake.
  let lastClickError: unknown = null
  let clicked = false
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    try {
      await markScreenshotAndClick(
        await $(`button*=${conflictAgentLabel}`),
        nextShotName(`selecionar-agente-conflito-${conflictAgentLabel}`),
      )
      clicked = true
    } catch (err) {
      lastClickError = err
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  if (!clicked) throw lastClickError

  // Selecting the card reveals the "Agent model (<PROVIDER>)" section —
  // confirms it really appeared (the dropdown stays at its default value,
  // no need to change it, but the section needs to genuinely exist on screen).
  const modelLabel = await $(`label*=Modelo do agente (${conflictAgentLabel.toUpperCase()})`)
  await modelLabel.waitForDisplayed({ timeout: 5_000 })
  await captureScreenshot(nextShotName(`modelo-do-agente-${conflictAgentLabel}`))

  // `ModelSearchablePicker` — trigger + search + list, all inline (NO
  // portal, unlike `Dropdown.tsx` — doesn't suffer from the
  // pointer-events bug already fixed there). Explicit request from the owner: always
  // explicitly pick the FREE model, never rely on the default.
  if (modelSearchTerm) {
    const modelFieldContainer = await modelLabel.$('..')
    const modelTrigger = await modelFieldContainer.$('button')
    await markScreenshotAndClick(modelTrigger, nextShotName('abrir-seletor-modelo'))

    const searchInput = await $('input[placeholder*="Pesquisar entre"]')
    await searchInput.waitForDisplayed({ timeout: 5_000 })
    await searchInput.setValue(modelSearchTerm)
    await captureScreenshot(nextShotName(`modelos-filtrados-${modelSearchTerm}`))

    const dropdownContainer = await searchInput.$('../..')
    const modelOption = await dropdownContainer.$(`button*=${modelSearchTerm}`)
    await modelOption.waitForClickable({ timeout: 5_000 })
    await markScreenshotAndClick(modelOption, nextShotName(`selecionar-modelo-${modelSearchTerm}`))
  }

  const checkbox = await $('#autoWorktree')
  await checkbox.waitForDisplayed({ timeout: 10_000 })
  if (!(await checkbox.isSelected())) {
    await markScreenshotAndClick(checkbox, nextShotName('marcar-autoworktree'))
  }
  if (!(await checkbox.isSelected())) {
    throw new Error(
      'selectConflictAgentAndAutoWorktreeViaUi: autoWorktree checkbox did not check after the click',
    )
  }

  await saveProjectSettings()

  // Real verification that it persisted — ONLY MAKES SENSE after "Save":
  // `EditProjectModal.tsx` keeps the card selection in LOCAL React state
  // while the modal is open; it only writes to
  // `project.conflictAgentProvider` (the real store) when "Save" is
  // clicked. Checking before that always returned `null`, even with the
  // correct click (a test bug, not an app bug — confirmed live).
  const provider = await getConflictAgentProvider(projectId)
  const normalizedLabel = conflictAgentLabel.toLowerCase().replace(/\s+/g, '')
  if (!provider || !normalizedLabel.includes(provider.toLowerCase())) {
    throw new Error(
      `selectConflictAgentAndAutoWorktreeViaUi: expected conflictAgentProvider compatible with "${conflictAgentLabel}" after saving, got "${provider}"`,
    )
  }
}

/**
 * PHASE 2: reopens Settings (the autoWorktree toggle is now truly
 * saved) and clicks "Migrate existing terminals now" — only makes
 * sense after at least 1 real terminal already exists in the project
 * (`completeAutoOpenedNewTerminalModal`, never cancelled). Triggers a native
 * `confirm()`. Confirms that the migration doesn't navigate the modal to some
 * other unexpected place (same class of navigation bug already found in
 * `NewTerminalModal.tsx` — treated as a suspicion to verify, not assumed OK).
 */
export async function migrateExistingTerminalsViaUi(): Promise<void> {
  await openProjectAgentsSettings()

  const migrateButton = await $('button*=Migrar terminais existentes agora')
  if (!(await migrateButton.isExisting())) {
    throw new Error(
      'migrateExistingTerminalsViaUi: "Migrate existing terminals now" button did not appear — does the project have any real terminal to migrate?',
    )
  }
  await clickAndAcceptConfirm(
    'button*=Migrar terminais existentes agora',
    'migrar-terminais-existentes',
  )
  // Confirms that the migration didn't navigate somewhere else: the Agents tab
  // (and the autoWorktree checkbox itself) need to remain visible.
  const stillOnAgentsTab = await $('#autoWorktree').isExisting()
  if (!stillOnAgentsTab) {
    throw new Error(
      'migrateExistingTerminalsViaUi: "Migrate existing terminals now" navigated away from the Agents tab',
    )
  }
  await captureScreenshot(nextShotName('agentes-tab-apos-migrar'))
}

/**
 * PHASE 3: within the SAME modal session left open by
 * `migrateExistingTerminalsViaUi`, switches to the "Merge" tab, selects the
 * agent's post-merge action, and saves/closes — closing the configuration
 * cycle.
 */
export async function selectMergePostActionAndSaveViaUi(
  postMergeAction: MergePostAction,
): Promise<void> {
  const mergeTab = await $('button*=Merge')
  await mergeTab.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(mergeTab, nextShotName('aba-merge'))

  const postActionRadio = await $(`input[name="mergePostAction"][value="${postMergeAction}"]`)
  await postActionRadio.waitForDisplayed({ timeout: 5_000 })
  await markScreenshotAndClick(
    postActionRadio,
    nextShotName(`selecionar-pos-merge-${postMergeAction}`),
  )
  if (!(await postActionRadio.isSelected())) {
    throw new Error(
      `selectMergePostActionAndSaveViaUi: post-merge action radio "${postMergeAction}" did not check after the click`,
    )
  }

  await saveProjectSettings()
}

/**
 * Opens a new agent terminal through the real UI: clicks the project's "+",
 * selects the agent card by exact TEXT INSIDE the "New
 * terminal" modal (never a loose search on the whole page — the project
 * Settings' "Agents" tab has cards with the SAME labels further down, for
 * the conflict resolution agent; that collision is what made a previous test
 * mistakenly select "Mimo" when it should have selected
 * "OpenCode"), visually CONFIRMS (`aria-pressed` + submit button text)
 * that the correct agent got selected before clicking, and NEVER
 * touches the folder's "Browse" button.
 */
export async function openAgentTerminalViaUi(agentLabel: string): Promise<void> {
  await waitNoDialogOpen()

  const newTerminalBtn = await $('[title="Novo terminal"]')
  await newTerminalBtn.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(newTerminalBtn, nextShotName('abrir-novo-terminal'))

  await selectAgentInOpenNewTerminalModal(agentLabel)
}

/**
 * Selects the agent and clicks "Open <Agent>" in a "New terminal" modal that
 * is ALREADY OPEN — reused both by `openAgentTerminalViaUi` (which
 * opens the modal first, via the project's "+") and by the modal that opens
 * ON ITS OWN right after creating a project (`completeAutoOpenedNewTerminal`)
 * — same screen, same selectors, only who opened it differs.
 */
async function selectAgentInOpenNewTerminalModal(agentLabel: string): Promise<void> {
  // Scopes the search to the `[role="dialog"]` (Radix Dialog.Content) — SAME
  // pattern already fixed before in `closeProjectSettings()` for the same type of
  // collision: going up "2 parent levels" from the `<h2>` is fragile and already
  // collided live with the Home's quick agent selector (`HomeView`
  // also has an "OpenCode" button with icon+text, just hidden inside
  // a closed `<details>` — "element not interactable", not "not
  // found", because the element exists in the DOM but never becomes visible).
  const modal = await $('[role="dialog"]')
  await modal.waitForDisplayed({ timeout: 10_000 })
  const modalTitle = await modal.$('h2*=Novo terminal')
  await modalTitle.waitForDisplayed({ timeout: 10_000 })

  const agentCard = await modal.$(`button*=${agentLabel}`)
  await agentCard.waitForClickable({ timeout: 10_000 })
  await markScreenshotAndClick(agentCard, nextShotName(`selecionar-agente-${agentLabel}`))

  const openButton = await modal.$(`button*=Abrir ${agentLabel}`)
  await openButton.waitForDisplayed({ timeout: 5_000 })
  const pressed = await agentCard.getAttribute('aria-pressed')
  if (pressed !== 'true') {
    throw new Error(
      `selectAgentInOpenNewTerminalModal: card "${agentLabel}" did not end up with aria-pressed=true after the click (got "${pressed}")`,
    )
  }

  await openButton.waitForClickable({ timeout: 5_000 })
  await markScreenshotAndClick(openButton, nextShotName(`abrir-agente-${agentLabel}`))

  await waitNoDialogOpen()
}

/**
 * Completes (does not cancel) the "New terminal" modal that opens ON ITS OWN
 * right after creating a project — explicit request from the owner: the first terminal
 * needs to genuinely exist (with real history, not cancelled) BEFORE going to
 * Settings, otherwise "Migrate existing terminals now" has nothing
 * real to migrate (the project wouldn't have any terminal yet).
 */
export async function completeAutoOpenedNewTerminalModal(agentLabel: string): Promise<void> {
  await selectAgentInOpenNewTerminalModal(agentLabel)
}
