import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'context-lens',
  component: 'Pane',
  requestId: 'context-lens',
  props: {
    title: 'Context lens',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('pane draws on every surface', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 123456, window: 1000000, percent: 12 }, rateLimits: [] },
  }))
  for (const surface of ['desktop', 'terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const t = await ui.find({ type: 'Text', text: /12%/ })
    expect(t?.text).toContain('· 12%')
    await ui.unmount()
  }
})

test('draws with an Obsidian vault set', { options: { obsidianVault: '/tmp/vault' } }, async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 1000000, percent: 0 }, rateLimits: [] },
  }))
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Loaded at start/ }))?.text).toBe('Loaded at start')
    await ui.unmount()
  }
})

const MEM = '/Users/x/.claude/projects/p/memory'
const VAULT = '/v/notes'
const LINK = `${VAULT}/_claude/claude/projects/p/memory`
const OPEN = `obsidian://open?vault=notes&file=${encodeURIComponent('_claude/claude/projects/p/memory/a.md')}`

// Runs one press of a memory file's name against a fake disk; returns the commands run.
const pressMemoryFile = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  disk: { readlink?: string; isRealDir?: boolean },
) => {
  const ran: string[] = []
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    ran.push(e.argv.join(' '))
    const cmd = e.argv[0]
    const exitCode =
      cmd === 'readlink' ? (disk.readlink === undefined ? 1 : 0) : cmd === 'test' ? (disk.isRealDir ? 0 : 1) : 0
    return { value: { exitCode, stdout: cmd === 'readlink' ? `${disk.readlink ?? ''}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.tool.call({ tool: 'Read', file_path: `${MEM}/a.md` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pressed = ui.press({ key: `open:${MEM}/a.md` })
  for (let i = 0; i < 6; i++) await clock.advance(1000)
  await pressed
  await ui.unmount()
  return ran
}

test('a memory folder already linked is opened, the link untouched', { options: { obsidianVault: VAULT } }, async ($, on) => {
  const ran = await pressMemoryFile($, on, { readlink: MEM })
  expect(ran).toEqual([`readlink ${LINK}`, `open ${OPEN}`])
})

test('a memory file links its whole folder, then opens', { options: { obsidianVault: VAULT } }, async ($, on) => {
  const ran = await pressMemoryFile($, on, {})
  expect(ran).toEqual([
    `readlink ${LINK}`,
    `test -e ${LINK}`,
    `mkdir -p ${VAULT}/_claude/claude/projects/p`,
    `ln -s ${MEM} ${LINK}`,
    `open ${OPEN}`,
  ])
})

test('a stale link or folder is removed before the new link, never swapped in place', { options: { obsidianVault: VAULT } }, async ($, on) => {
  const wrong = await pressMemoryFile($, on, { readlink: '/elsewhere' })
  expect(wrong.slice(0, 3)).toEqual([`readlink ${LINK}`, `unlink ${LINK}`, `mkdir -p ${VAULT}/_claude/claude/projects/p`])
  expect(wrong).toContain(`ln -s ${MEM} ${LINK}`)
})
