import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inject, Load, Turn } from '../types'

const PANE = 'context-lens'
const TITLE = 'Context lens'
const loads = atom({ plugin: 'context-lens', key: 'loads' } as const, [], { shape: 'loads-1' })
const injects = atom({ plugin: 'context-lens', key: 'injects' } as const, [], { shape: 'injects-1' })
const turns = atom({ plugin: 'context-lens', key: 'turns' } as const, [], { shape: 'turns-1' })

const est = (s: string) => Math.ceil(s.length / 4)
const MEM_RE = /(CLAUDE\.md|CLAUDE\.local\.md|MEMORY\.md|\/memory\/[^/]+\.md|\/\.claude\/rules\/[^/]+\.md)$/
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const short = (p: string) =>
  p.replace(/^\/Users\/[^/]+/, '~').replace(/\/\.claude\/projects\/[^/]+\/memory\//, '/…/memory/')
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const HOW_LABEL: Record<Load['how'], string> = {
  startup: 'startup',
  import: '@import',
  nested: 'nested',
  read: 'agent Read',
  write: 'agent Write',
}

async function addLoad($: EngineInterface, l: Omit<Load, 'at'>) {
  const at = await $.clock.now()
  await update($, loads, list => [...list, { ...l, at }].slice(-300))
}

export const register: Register = on => {
  let tools = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx-lens', description: 'Open the Context lens pane' })
    void $.ui.open({ id: PANE, title: TITLE })
    const r = await next(e)
    try {
      const have = await read($, loads)
      if (!have.some(l => l.how === 'startup')) {
        const u = await $.session.usage({ breakdown: 'summary' })
        const at = await $.clock.now()
        const files = u.context.breakdown?.memoryFiles ?? []
        if (files.length)
          await update($, loads, list => [
            ...files.map(f => ({ at, path: f.path, how: 'startup' as const, kind: f.type, tokens: f.tokens })),
            ...list,
          ])
      }
    } catch {}
    return r
  })

  on('command.run', { command: 'ctx-lens' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Context lens opened.' }
  })

  // CLAUDE.md hierarchy as composed into the first message
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const files = r.instructionFiles ?? e.instructionFiles ?? []
    if (files.length) {
      const at = await $.clock.now()
      await update($, loads, list => [
        ...list.filter(l => l.how !== 'startup' && l.how !== 'import'),
        ...files.map(f => ({
          at,
          path: f.path,
          how: (f.parent ? 'import' : 'startup') as Load['how'],
          kind: f.kind,
          parent: f.parent,
          tokens: est(f.content),
        })),
      ])
    }
    return r
  })

  // everything the engine injects on its own (reminders, nested CLAUDE.md, listings…)
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      const origin = e.origin.kind === 'engine' ? 'engine' : `${e.origin.kind}:${e.origin.event}`
      await update($, injects, list =>
        [...list, { at, type: e.type, tokens: est(e.text), origin }].slice(-200),
      )
      if (e.type === 'nested_memory') {
        const m = e.text.match(/Contents of (\S+?)(?:\s|:|$)/)
        await addLoad($, { path: m?.[1] ?? '(nested CLAUDE.md)', how: 'nested', kind: 'project', tokens: est(e.text) })
      }
    }
    return r
  })

  // agent reading / writing memory files itself
  on('tool.call', async ($, e, next) => {
    tools += 1
    const ran = await next(e)
    try {
    if (e.agentId === undefined) {
      const p = (e as unknown as { file_path?: unknown }).file_path
      if (typeof p === 'string' && MEM_RE.test(p)) {
        const t = String(e.tool)
        if (t === 'Read') await addLoad($, { path: p, how: 'read', kind: 'file', tokens: 0 })
        else if (t === 'Write' || t === 'Edit') await addLoad($, { path: p, how: 'write', kind: 'file', tokens: 0 })
      }
    }
    } catch {}
    return ran
  })

  // context growth per turn
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    const tokens = u.context.tokens ?? 0
    const at = await $.clock.now()
    const n = tools
    tools = 0
    await update($, turns, list => {
      const prev = list.at(-1)?.tokens ?? 0
      return [...list, { at, tokens, delta: tokens - prev, tools: n }].slice(-50)
    })
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [L, I, T] = await Promise.all([read($, loads), read($, injects), read($, turns)])

    // hierarchy: roots = startup files without parent; children = @imports by parent
    const startup = L.filter(l => l.how === 'startup')
    const kids = (p: string) => L.filter(l => l.how === 'import' && l.parent === p)
    const later = L.filter(l => l.how === 'nested' || l.how === 'read' || l.how === 'write')

    // injects aggregated by type
    const byType = new Map<string, { n: number; tokens: number; last: number; origin: string }>()
    for (const i of I) {
      const cur = byType.get(i.type) ?? { n: 0, tokens: 0, last: 0, origin: i.origin }
      byType.set(i.type, { n: cur.n + 1, tokens: cur.tokens + i.tokens, last: i.at, origin: i.origin })
    }
    const inj = [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens)

    const lastTurns = T.slice(-8)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Memory hierarchy (loaded at start)</Text>
          {startup.length === 0 && <Text dimColor>Not seen yet — fills on next session start / after /clear.</Text>}
          {startup.map(f => (
            <Box flexDirection="column">
              <Text>
                <Text color="permission">[{f.kind}]</Text> {short(f.path)} <Text dimColor>~{k(f.tokens)} tok</Text>
              </Text>
              {kids(f.path).map(c => (
                <Text dimColor>  └ @import {short(c.path)} ~{k(c.tokens)}</Text>
              ))}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Loaded later</Text>
          {later.length === 0 && <Text dimColor>No nested CLAUDE.md or memory reads/writes yet.</Text>}
          {later.slice(-15).map(l => (
            <Text>
              <Text dimColor>{hhmm(l.at)}</Text> <Text color={l.how === 'write' ? 'warning' : 'suggestion'}>{HOW_LABEL[l.how]}</Text>{' '}
              {short(l.path)}
              {l.tokens ? <Text dimColor> ~{k(l.tokens)}</Text> : null}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Injected by harness (this session)</Text>
          {inj.length === 0 && <Text dimColor>None yet.</Text>}
          {inj.slice(0, 12).map(([type, v]) => (
            <Text>
              {type} <Text dimColor>×{v.n} · ~{k(v.tokens)} tok · {v.origin} · last {hhmm(v.last)}</Text>
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Context growth per turn</Text>
          {lastTurns.length === 0 && <Text dimColor>Fills as turns end.</Text>}
          {lastTurns.map(t => (
            <Text>
              <Text dimColor>{hhmm(t.at)}</Text> {k(t.tokens)}{' '}
              <Text color={t.delta > 20000 ? 'error' : 'success'}>{t.delta >= 0 ? '+' : ''}{k(t.delta)}</Text>
              <Text dimColor> · {t.tools} tools</Text>
            </Text>
          ))}
        </Box>

        <Box>
          <Button
            key="clear"
            label="Clear log"
            onPress={async () => {
              await update($, injects, () => [])
              await update($, turns, () => [])
              await update($, loads, l => l.filter(x => x.how === 'startup' || x.how === 'import'))
            }}
          />
        </Box>
      </Box>
    )
  })
}
