import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

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

const sign = (n: number) => (n >= 0 ? '+' : '−')
const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p
const dir = (p: string) => short(p).split('/').slice(0, -1).join('/') || '/'
const pretty = (t: string) => t.replace(/_/g, ' ')
const tierLabel = (kind: string) => (kind.toLowerCase() === 'automem' ? 'memory' : kind.toLowerCase())

// Map an absolute path to a vault-relative symlink path: home-relative, dots stripped
// (Obsidian hides dot-folders).
function vaultRel(path: string, folder: string): string {
  const rel = path.replace(/^\/(Users|home)\/[^/]+\//, '').replace(/^\//, '')
  const segs = rel.split('/').map(s => s.replace(/^\.+/, ''))
  return [folder.replace(/^\/+|\/+$/g, ''), ...segs].filter(Boolean).join('/')
}

async function openInObsidian($: EngineInterface, path: string, vault: string, folder: string) {
  const v = vault.replace(/\/+$/, '')
  const rel = vaultRel(path, folder)
  const link = `${v}/${rel}`
  const parent = link.split('/').slice(0, -1).join('/')
  try {
    await $.process.run(['mkdir', '-p', parent])
    await $.process.run(['ln', '-sfn', path, link])
    const url = `obsidian://open?vault=${encodeURIComponent(base(v))}&file=${encodeURIComponent(rel)}`
    await $.process.run(['open', url])
  } catch {
    $.ui.toast(`Couldn't open ${base(path)} in Obsidian`)
  }
}

async function addLoad($: EngineInterface, l: Omit<Load, 'at'>) {
  const at = await $.clock.now()
  await update($, loads, list => [...list, { ...l, at }].slice(-300))
}

export const register: Register = (on, options) => {
  const vault = typeof options.obsidianVault === 'string' ? options.obsidianVault.trim() : ''
  const folder = typeof options.obsidianFolder === 'string' && options.obsidianFolder.trim() ? options.obsidianFolder.trim() : '_claude'
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
    const [L, I, T, u] = await Promise.all([read($, loads), read($, injects), read($, turns), $.session.usage()])

    const Section = (p: { title: string; meta?: string; children?: RenderChildren }) => (
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text size="caption" dimColor>{p.title}</Text>
          {p.meta ? <Text size="caption" dimColor tabular>{p.meta}</Text> : null}
        </Box>
        {p.children}
      </Box>
    )
    const Empty = (p: { text: string }) => <Text size="footnote" dimColor>{p.text}</Text>
    const Name = (p: { path: string; suffix?: string }) =>
      vault ? (
        <Button
          key={`open:${p.path}`}
          plain
          label={`${base(p.path)}${p.suffix ?? ''}`}
          onPress={() => openInObsidian($, p.path, vault, folder)}
        />
      ) : (
        <Text wrap="truncate-middle">{base(p.path)}{p.suffix ?? ''}</Text>
      )
    const FileRow = (p: { path: string; left?: string; right?: string; indent?: boolean; suffix?: string }) => (
      <Box justifyContent="space-between" gap={1} paddingLeft={p.indent ? 2 : 0}>
        <Box gap={1} flexShrink={1}>
          {p.left ? <Text size="footnote" dimColor mono>{p.left}</Text> : null}
          <Name path={p.path} suffix={p.suffix} />
          <Text size="footnote" dimColor wrap="truncate-start">{dir(p.path)}</Text>
        </Box>
        {p.right ? <Text size="footnote" dimColor tabular>{p.right}</Text> : null}
      </Box>
    )

    // startup tree
    const startup = L.filter(l => l.how === 'startup')
    const kids = (p: string) => L.filter(l => l.how === 'import' && l.parent === p)
    const memTotal = L.filter(l => l.how === 'startup' || l.how === 'import').reduce((s, l) => s + l.tokens, 0)

    // later, deduped
    const lat = new Map<string, Load & { n: number }>()
    for (const l of L) {
      if (l.how !== 'nested' && l.how !== 'read' && l.how !== 'write') continue
      const key = `${l.how}|${l.path}`
      lat.set(key, { ...l, n: (lat.get(key)?.n ?? 0) + 1 })
    }
    const later = [...lat.values()].sort((a, b) => b.at - a.at)

    // injected
    const byType = new Map<string, { n: number; tokens: number; origin: string }>()
    for (const i of I) {
      const c = byType.get(i.type) ?? { n: 0, tokens: 0, origin: i.origin }
      byType.set(i.type, { n: c.n + 1, tokens: c.tokens + i.tokens, origin: i.origin })
    }
    const inj = [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
    const injTotal = inj.reduce((s, [, v]) => s + v.tokens, 0)

    const recent = T.slice(-5).reverse()

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text size="footnote" dimColor tabular>
          {k(u.context.tokens ?? 0)} / {k(u.context.window)} · {u.context.percent ?? 0}%
        </Text>

        <Section title="Loaded at start" meta={startup.length ? `~${k(memTotal)}` : undefined}>
          {startup.length === 0 ? <Empty text="Fills on next session start or /clear." /> : null}
          {startup.map(f => (
            <Box flexDirection="column">
              <FileRow path={f.path} left={tierLabel(f.kind).padEnd(7)} right={k(f.tokens)} />
              {kids(f.path).map(c => (
                <FileRow path={c.path} left="└" right={k(c.tokens)} indent />
              ))}
            </Box>
          ))}
        </Section>

        <Section title="Loaded during session" meta={later.length ? `${later.length}` : undefined}>
          {later.length === 0 ? <Empty text="None yet." /> : null}
          {later.slice(0, 12).map(l => (
            <FileRow
              path={l.path}
              left={`${hhmm(l.at)} ${HOW_LABEL[l.how].padEnd(11)}`}
              suffix={l.n > 1 ? ` ×${l.n}` : undefined}
            />
          ))}
        </Section>

        <Section title="Injected by harness" meta={inj.length ? `~${k(injTotal)}` : undefined}>
          {inj.length === 0 ? <Empty text="None yet." /> : null}
          {inj.slice(0, 10).map(([type, v]) => (
            <Box justifyContent="space-between">
              <Text size="footnote">
                {pretty(type)}<Text dimColor> ×{v.n}{v.origin !== 'engine' ? ` · ${v.origin}` : ''}</Text>
              </Text>
              <Text size="footnote" dimColor tabular>{k(v.tokens)}</Text>
            </Box>
          ))}
        </Section>

        <Section title="Per turn">
          {recent.length === 0 ? <Empty text="None yet." /> : null}
          {recent.map(t => (
            <Box justifyContent="space-between">
              <Text size="footnote" dimColor mono>{hhmm(t.at)}</Text>
              <Text size="footnote" tabular>{k(t.tokens)}</Text>
              <Text size="footnote" tabular dimColor={t.delta <= 20000} color={t.delta > 20000 ? 'warning' : undefined}>
                {sign(t.delta)}{k(Math.abs(t.delta))}
              </Text>
              <Text size="footnote" dimColor tabular>{t.tools} tools</Text>
            </Box>
          ))}
        </Section>

        <Box marginTop={1}>
          <Button
            key="clear"
            plain
            dimColor
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
