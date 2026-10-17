import { describe, expect, it } from 'vitest'

import { answerAllowed, describeRequest, isDestructive, parseSpokenAnswer } from './permissions'

const bash = (command: string, cwd = '/work/app') => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
})

describe('describeRequest', () => {
  it('names the command, file or URL a request is about', () => {
    expect(describeRequest(bash('npm install express'))).toEqual({
      tool: 'Bash',
      subject: 'npm install express',
    })
    expect(
      describeRequest({ tool_name: 'Edit', tool_input: { file_path: '/work/app/src/auth.ts' } }),
    ).toEqual({ tool: 'Edit', subject: '/work/app/src/auth.ts' })
    expect(
      describeRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }),
    ).toEqual({ tool: 'WebFetch', subject: 'https://example.com' })
  })

  // The caller names an unnamed tool in the person's language.
  it('leaves the tool unnamed when the request carries none', () => {
    expect(describeRequest({ tool_input: { command: 'ls' } })).toEqual({
      tool: null,
      subject: 'ls',
    })
  })
})

describe('isDestructive', () => {
  it.each([
    'rm -rf node_modules',
    'rm -r build',
    'sudo rm -fr /tmp/x',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'git branch -D feature',
    'psql -c "DROP TABLE users"',
    'mysql -e "truncate table logs"',
    'Remove-Item -Recurse -Force dist',
    'rmdir /s /q build',
    'dd if=/dev/zero of=/dev/sda',
    'rm -v -rf build',
    'rm --recursive --force build',
    'rm build -rf',
    'rm -R dir',
    'git push origin +main',
    'git push -uf origin main',
    'git push --delete origin feature',
    'git push origin :feature',
    'git clean --force -d',
    'git branch --delete --force feature',
    'Remove-Item -r dist',
    'Remove-Item dist -Rec',
    'npm test && rm -rf dist',
    'bash -c "rm -rf build"',
    "sh -c 'rm -rf /'",
    'cmd /c "rmdir /s /q build"',
    'powershell -Command "Remove-Item -Recurse dist"',
    '(rm -rf build)',
    'echo $(rm -rf x)',
    '`rm -rf x`',
    'echo "DROP TABLE users" | psql',
    'psql <<EOF\nDROP TABLE x;\nEOF',
    'Remove-Item -Recurse:$true dist',
    'rm "-rf" build',
    // git global options before the subcommand
    'git -C /repo push --force',
    'git -c a=b reset --hard',
    'git --git-dir=x --work-tree=y clean -fd',
    'git --no-pager push -f',
    'git --namespace=n push --force',
    'git -C ../other reset --hard',
    // PowerShell and cmd aliases of Remove-Item
    'del -Recurse dist',
    'ri -r dist',
    'rd -Recurse x',
    'erase -Recurse x',
    'rmdir -r x',
    'erase /s x',
    // whole-tree discards
    'git push --mirror',
    'git checkout -- .',
    'git checkout .',
    'git restore .',
    'git restore --staged --worktree .',
    // deleting or moving outside the project
    'rm ../../other/file',
    'rm ~/.ssh/id_rsa',
    'rm /etc/hosts',
    'Remove-Item C:\\Windows\\x',
    'mv ~/.bashrc x',
    'rm $HOME/.bashrc',
    'del %USERPROFILE%\\x',
    'rm src/../../x',
  ])('flags %s', (command) => {
    expect(isDestructive(bash(command))).toBe(true)
  })

  it.each([
    'npm install express',
    'git push origin main',
    'git status',
    'rm notes.txt',
    'ls -rf',
    'rm ./build/x.log',
    'rm /work/app/build/x.log',
    'git checkout main',
    'git restore --staged file.ts',
    'git restore --staged .',
    'git -C /repo status',
    'mv a.txt b.txt',
    'del /q notes.txt',
  ])('lets %s through', (command) => {
    expect(isDestructive(bash(command))).toBe(false)
  })

  it('treats any absolute or home path as outside when the project directory is unknown', () => {
    const noCwd = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
    expect(isDestructive(noCwd('rm /work/app/x.log'))).toBe(true)
    expect(isDestructive(noCwd('rm ~/x'))).toBe(true)
    expect(isDestructive(noCwd('rm x.log'))).toBe(false)
  })

  it('flags writes outside the project and allows writes inside it', () => {
    const write = (file_path: string) => ({
      tool_name: 'Write',
      tool_input: { file_path },
      cwd: '/work/app',
    })
    expect(isDestructive(write('/work/app/src/a.ts'))).toBe(false)
    expect(isDestructive(write('/etc/hosts'))).toBe(true)
    expect(isDestructive(write('/work/application/x.ts'))).toBe(true)
  })

  it('resolves .. segments before checking the project boundary', () => {
    const write = (file_path: string, cwd: string | undefined = '/work/app') => ({
      tool_name: 'Write',
      tool_input: { file_path },
      cwd,
    })
    expect(isDestructive(write('/work/app/../../etc/hosts'))).toBe(true)
    expect(isDestructive(write('/work/app/src/../a.ts'))).toBe(false)
    expect(isDestructive(write('src/a.ts'))).toBe(false)
    expect(isDestructive(write('../other/a.ts'))).toBe(true)
    expect(
      isDestructive({
        tool_name: 'Edit',
        tool_input: { file_path: 'c:\\Work\\App\\..\\..\\Windows\\win.ini' },
        cwd: 'C:/work/app',
      }),
    ).toBe(true)
  })

  it('treats home and environment-variable paths as outside the project', () => {
    const write = (file_path: string) => ({
      tool_name: 'Write',
      tool_input: { file_path },
      cwd: '/work/app',
    })
    expect(isDestructive(write('~/.bashrc'))).toBe(true)
    expect(isDestructive(write('~/.ssh/authorized_keys'))).toBe(true)
    expect(isDestructive(write('$HOME/.bashrc'))).toBe(true)
    expect(isDestructive(write('%USERPROFILE%\\x'))).toBe(true)
  })

  it('fails closed when the project directory is unknown', () => {
    expect(isDestructive({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } })).toBe(
      true,
    )
    expect(isDestructive({ tool_name: 'Edit', tool_input: { file_path: '/work/app/a.ts' } })).toBe(
      true,
    )
  })

  it('compares Windows paths without case or slash differences', () => {
    expect(
      isDestructive({
        tool_name: 'Edit',
        tool_input: { file_path: 'c:\\Work\\App\\src\\a.ts' },
        cwd: 'C:/work/app',
      }),
    ).toBe(false)
  })
})

describe('parseSpokenAnswer', () => {
  it.each(['yes', 'Yes.', 'yeah', 'sure', 'allow', 'ok', 'sim', 'pode', 'Pode sim.', 'claro'])(
    'hears %s as allow',
    (text) => {
      expect(parseSpokenAnswer(text)).toEqual({ kind: 'allow' })
    },
  )

  it.each(['no', 'No.', 'não', 'nope', 'deny', 'negado'])('hears %s as deny', (text) => {
    expect(parseSpokenAnswer(text)).toEqual({ kind: 'deny' })
  })

  it('keeps the reason of a deny so Claude reads it as an instruction', () => {
    expect(parseSpokenAnswer('No, use pnpm instead')).toEqual({
      kind: 'deny',
      message: 'use pnpm instead',
    })
    expect(parseSpokenAnswer('Não, roda só os testes de auth')).toEqual({
      kind: 'deny',
      message: 'roda só os testes de auth',
    })
  })

  it('does not hear a qualified yes as an approval', () => {
    expect(parseSpokenAnswer('yes but only in the test folder')).toEqual({ kind: 'unclear' })
    expect(parseSpokenAnswer('maybe')).toEqual({ kind: 'unclear' })
    expect(parseSpokenAnswer('')).toEqual({ kind: 'unclear' })
  })
})

describe('answerAllowed', () => {
  const both = { channel: 'both' as const, destructiveNeedsHud: true }

  it('refuses a spoken yes to a destructive request by default', () => {
    expect(answerAllowed({ kind: 'allow' }, true, both, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, true, both, 'hud')).toBe(true)
  })

  it('accepts a spoken no to a destructive request', () => {
    expect(answerAllowed({ kind: 'deny' }, true, both, 'voice')).toBe(true)
  })

  it('accepts a spoken yes to a destructive request when the person turned the guard off', () => {
    expect(
      answerAllowed(
        { kind: 'allow' },
        true,
        { channel: 'both', destructiveNeedsHud: false },
        'voice',
      ),
    ).toBe(true)
  })

  it('follows the approval channel', () => {
    const hudOnly = { channel: 'hud' as const, destructiveNeedsHud: true }
    const voiceOnly = { channel: 'voice' as const, destructiveNeedsHud: true }
    expect(answerAllowed({ kind: 'allow' }, false, hudOnly, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, false, voiceOnly, 'hud')).toBe(false)
    // The guard needs a click, so the panel answers a destructive request even in voice-only mode.
    expect(answerAllowed({ kind: 'allow' }, true, voiceOnly, 'hud')).toBe(true)
  })

  it('always lets the person hand the question back to the terminal', () => {
    expect(answerAllowed({ kind: 'defer' }, true, both, 'hud')).toBe(true)
    expect(
      answerAllowed(
        { kind: 'defer' },
        false,
        { channel: 'voice', destructiveNeedsHud: true },
        'hud',
      ),
    ).toBe(true)
  })
})
