import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function realBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe.exe' : 'alethe'
  // target-e2e, not target/: an isolated build that never shares the binary or the
  // build lock with the owner's interactive `tauri dev` session (see
  // CARGO_TARGET_DIR in the `test:e2e:build` script in package.json).
  return join(ROOT, 'src-tauri', 'target-e2e', 'debug', name)
}

/**
 * Isolates the data dir in a temporary folder, to guarantee ZERO contact with the
 * owner's real profile (`%LOCALAPPDATA%\Alethe` on Windows, `~/.local/share`
 * on Linux, etc.).
 *
 * REAL BUG CONFIRMED IN THIS SESSION (found by the owner, running live): the
 * previous version of this file overrode `APPDATA` (the Roaming folder) on
 * Windows, but Tauri's `app.path().app_local_data_dir()` resolves via
 * `%LOCALAPPDATA%` (the Local folder) — a DIFFERENT variable, never touched. The
 * isolation never actually worked on Windows: every e2e run opened
 * against the owner's real profile, with real projects/repositories. Confirmed
 * empirically (`%APPDATA%\Alethe` doesn't even exist; `%LOCALAPPDATA%\Alethe` is
 * where the real data lives).
 *
 * Fix: uses `ALETHE_APP_DATA_DIR`, the explicit override that BOTH
 * `resolve_tauri_data_root` (desktop) AND `resolve_standalone_data_root`
 * (`alethe-server`) check BEFORE any OS-specific resolution
 * (`src-tauri/src/profiles.rs`) — doesn't depend on guessing which environment
 * variable the OS/Tauri actually consults on each platform. Keeps
 * `HOME`/`APPDATA`/`XDG_DATA_HOME` as reinforcement isolation (they never do
 * harm, they're just no longer the main protection).
 *
 * The real binary is pointed to directly in `application` (never a
 * `.cmd`/`.sh` wrapper): `@wdio/tauri-service` spawns with `child_process.spawn(path,
 * args, {...})` without `shell: true` (confirmed by reading the package) — on Windows,
 * spawning a `.cmd` without a shell fails with `EINVAL` (it's not a native executable
 * for `CreateProcess`), so a batch wrapper broke E2E on purpose.
 * The isolation environment variables go through
 * `wdio:tauriServiceOptions.env` (an option documented by the library itself, which
 * arrives intact at the final spawn — `mergeOptions` does a simple spread, with no
 * whitelist), not through a wrapper.
 */
export function prepareIsolatedLaunch(dataDir = mkdtempSync(join(tmpdir(), 'alethe-e2e-'))): {
  applicationPath: string
  dataDir: string
  env: Record<string, string>
  cleanup: () => void
} {
  const env: Record<string, string> = {
    ALETHE_E2E: '1',
    ALETHE_APP_DATA_DIR: dataDir,
    ...(process.platform === 'win32'
      ? { APPDATA: dataDir, LOCALAPPDATA: dataDir }
      : { HOME: dataDir, XDG_DATA_HOME: join(dataDir, '.local', 'share') }),
  }

  return {
    applicationPath: realBinaryPath(),
    dataDir,
    env,
    cleanup: () => {
      // Only deletes the temporary folder. Killing the process is the
      // @wdio/tauri-service's responsibility (it owns the lifecycle of the app it
      // spawned itself) — a pkill by name/path here would risk hitting the
      // owner's interactive `tauri dev` `target/debug/alethe`, which uses the
      // SAME binary. Never worth that risk just for test cleanup.
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
