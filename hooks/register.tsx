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

const HOW_COLOR: Record<Load['how'], string> = {
  startup: 'suggestion',
  import: 'inactive',
  nested: 'planMode',
  read: 'suggestion',
  write: 'warning',
}
const sign = (n: number) => (n >= 0 ? '+' : '−')
const base = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p
const dir = (p: string) => short(p).split('/').slice(0, -1).join('/') || '/'
const pretty = (t: string) => t.replace(/_/g, ' ')
const pctColor = (p: number) => (p >= 80 ? 'error' : p >= 50 ? 'warning' : 'success')
const tierLabel = (kind: string) => {
  const s = kind.toLowerCase()
  return s === 'automem' ? 'memory' : s
}
const tierColor = (kind: string) => {
  const s = kind.toLowerCase()
  if (s === 'user') return 'claude'
  if (s === 'project') return 'success'
  if (s === 'local') return 'merged'
  if (s === 'managed') return 'error'
  return 'permission'
}

function sparkSvg(ts: Turn[]): string {
  const W = 340, H = 96, P = 6, BH = 22
  const max = Math.max(...ts.map(t => t.tokens), 1)
  const dmax = Math.max(...ts.map(t => Math.abs(t.delta)), 1)
  const step = (W - P * 2) / Math.max(1, ts.length - 1)
  const top = H - BH - P * 2
  const pts = ts.map((t, i) => [P + i * step, P + top - (t.tokens / max) * top] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts.at(-1)![0].toFixed(1)},${(P + top).toFixed(1)} L${P},${(P + top).toFixed(1)} Z`
  const bw = Math.max(2, step * 0.6)
  const bars = ts
    .map((t, i) => {
      const h = Math.max(1, (Math.abs(t.delta) / dmax) * BH)
      const cls = t.delta > 20000 ? 'hi' : t.delta > 5000 ? 'mid' : 'lo'
      return `<rect class="${cls}" x="${(P + i * step - bw / 2).toFixed(1)}" y="${(H - P - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1"><title>${hhmm(t.at)} · ${k(t.tokens)} (${sign(t.delta)}${k(Math.abs(t.delta))})</title></rect>`
    })
    .join('')
  const [lx, ly] = pts.at(-1)!
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<style>
.l{fill:none;stroke:#3b82f6;stroke-width:1.8;stroke-linejoin:round}
.a{fill:url(#g)}.lo{fill:#22c55e}.mid{fill:#f59e0b}.hi{fill:#ef4444}
.d{fill:#3b82f6}.base{stroke:#8884;stroke-width:1}
rect:hover{opacity:.7}
</style>
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".35"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
<path class="a" d="${area}"/><path class="l" d="${line}"/>
<circle class="d" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3"/>
<line class="base" x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}"/>
${bars}
</svg>`
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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const [L, I, T, u] = await Promise.all([read($, loads), read($, injects), read($, turns), $.session.usage()])
    const pct = u.context.percent ?? 0
    const used = u.context.tokens ?? 0

    const Card = (p: { title: string; meta?: string; children?: RenderChildren }) => (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={2} paddingY={1} gap={1}>
        <Box justifyContent="space-between" alignItems="center">
          <Text size="footnote" weight="semibold" dimColor>{p.title.toUpperCase()}</Text>
          {p.meta ? <Text size="caption" dimColor tabular>{p.meta}</Text> : null}
        </Box>
        {p.children}
      </Box>
    )
    const Empty = (p: { text: string }) => <Text size="footnote" dimColor italic>{p.text}</Text>
    const Bar = (p: { frac: number; color: string }) => (
      <Box width="100%" height={1} backgroundColor="subtle" flexDirection="row">
        <Box width={`${Math.round(Math.max(2, Math.min(100, p.frac * 100)))}%`} height={1} backgroundColor={p.color} />
      </Box>
    )

    // ── header
    const header = (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box justifyContent="space-between" alignItems="flex-end">
          <Box flexDirection="column">
            <Text size="caption" dimColor>CONTEXT IN USE</Text>
            <Text size="title" weight="semibold" tabular>
              {k(used)} <Text size="body" dimColor>/ {k(u.context.window)}</Text>
            </Text>
          </Box>
          <Text size="heading" weight="semibold" tabular color={pctColor(pct)}>{pct}%</Text>
        </Box>
        <Bar frac={pct / 100} color={pctColor(pct)} />
      </Box>
    )

    // ── growth
    const lastT = T.slice(-24)
    const last = lastT.at(-1)
    const growth = (
      <Card title="Growth per turn" meta={last ? `last ${sign(last.delta)}${k(Math.abs(last.delta))}` : undefined}>
        {lastT.length < 2 || !Svg ? (
          <Empty text="Sparkline appears after a couple of turns." />
        ) : (
          <Svg source={sparkSvg(lastT)} alt={`Context tokens over the last ${lastT.length} turns`} isInteractive width={340} height={96} />
        )}
        {lastT.slice(-4).reverse().map(t => (
          <Box justifyContent="space-between">
            <Text size="footnote" mono dimColor>{hhmm(t.at)}</Text>
            <Text size="footnote" tabular>{k(t.tokens)}</Text>
            <Text size="footnote" tabular weight="medium" color={t.delta > 20000 ? 'error' : t.delta > 5000 ? 'warning' : 'success'}>
              {sign(t.delta)}{k(Math.abs(t.delta))}
            </Text>
            <Text size="footnote" dimColor tabular>{t.tools} tools</Text>
          </Box>
        ))}
      </Card>
    )

    // ── memory hierarchy
    const startup = L.filter(l => l.how === 'startup')
    const kids = (p: string) => L.filter(l => l.how === 'import' && l.parent === p)
    const memTotal = L.filter(l => l.how === 'startup' || l.how === 'import').reduce((s, l) => s + l.tokens, 0)
    const FileRow = (p: { l: Load; depth: number; isLast?: boolean }) => (
      <Box flexDirection="column">
        <Box justifyContent="space-between" alignItems="center" gap={1}>
          <Box gap={1} alignItems="center" flexShrink={1}>
            {p.depth > 0 ? <Text mono dimColor>{p.isLast ? '└─' : '├─'}</Text> : null}
            <Text size="caption" weight="semibold" color={tierColor(p.l.kind)}>● {tierLabel(p.l.kind)}</Text>
            <Text weight="medium" wrap="truncate-middle">{base(p.l.path)}</Text>
          </Box>
          <Text size="footnote" dimColor tabular>{k(p.l.tokens)}</Text>
        </Box>
        <Box paddingLeft={p.depth > 0 ? 3 : 0}>
          <Text size="caption" dimColor wrap="truncate-start">{dir(p.l.path)}</Text>
        </Box>
      </Box>
    )
    const hierarchy = (
      <Card title="Loaded at start" meta={startup.length ? `${startup.length} files · ~${k(memTotal)} tok` : undefined}>
        {startup.length === 0 ? (
          <Empty text="Fills on the next session start or /clear." />
        ) : (
          startup.map(f => {
            const ch = kids(f.path)
            return (
              <Box flexDirection="column" gap={0}>
                <FileRow l={f} depth={0} />
                {ch.map((c, i) => <FileRow l={c} depth={1} isLast={i === ch.length - 1} />)}
              </Box>
            )
          })
        )}
      </Card>
    )

    // ── later loads, deduped per path+how
    const lat = new Map<string, Load & { n: number }>()
    for (const l of L) {
      if (l.how !== 'nested' && l.how !== 'read' && l.how !== 'write') continue
      const key = `${l.how}|${l.path}`
      const cur = lat.get(key)
      lat.set(key, { ...l, n: (cur?.n ?? 0) + 1 })
    }
    const later = [...lat.values()].sort((a, b) => b.at - a.at)
    const timeline = (
      <Card title="Loaded during session" meta={later.length ? `${later.length}` : undefined}>
        {later.length === 0 ? (
          <Empty text="No nested CLAUDE.md or memory reads/writes yet." />
        ) : (
          later.slice(0, 12).map(l => (
            <Box gap={2} alignItems="center">
              <Text size="footnote" mono dimColor>{hhmm(l.at)}</Text>
              <Box width={9}>
                <Text size="caption" weight="semibold" color={HOW_COLOR[l.how]}>{HOW_LABEL[l.how]}</Text>
              </Box>
              <Box flexDirection="column" flexShrink={1}>
                <Text weight="medium" wrap="truncate-middle">
                  {base(l.path)}{l.n > 1 ? <Text dimColor> ×{l.n}</Text> : null}
                </Text>
                <Text size="caption" dimColor wrap="truncate-start">{dir(l.path)}</Text>
              </Box>
            </Box>
          ))
        )}
      </Card>
    )

    // ── injected
    const byType = new Map<string, { n: number; tokens: number; last: number; origin: string }>()
    for (const i of I) {
      const cur = byType.get(i.type) ?? { n: 0, tokens: 0, last: 0, origin: i.origin }
      byType.set(i.type, { n: cur.n + 1, tokens: cur.tokens + i.tokens, last: i.at, origin: i.origin })
    }
    const inj = [...byType.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
    const injTotal = inj.reduce((s, [, v]) => s + v.tokens, 0)
    const injMax = inj[0]?.[1].tokens ?? 1
    const injected = (
      <Card title="Injected by harness" meta={inj.length ? `${I.length} blocks · ~${k(injTotal)} tok` : undefined}>
        {inj.length === 0 ? (
          <Empty text="System reminders, listings and hook output show up here." />
        ) : (
          inj.slice(0, 10).map(([type, v]) => (
            <Box flexDirection="column" gap={0}>
              <Box justifyContent="space-between">
                <Text weight="medium">
                  {pretty(type)} <Text size="caption" dimColor>×{v.n}{v.origin !== 'engine' ? ` · ${v.origin}` : ''}</Text>
                </Text>
                <Text size="footnote" tabular dimColor>{k(v.tokens)}</Text>
              </Box>
              <Bar frac={v.tokens / injMax} color={v.origin === 'engine' ? 'suggestion' : 'claude'} />
            </Box>
          ))
        )}
      </Card>
    )

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {header}
        {growth}
        {hierarchy}
        {timeline}
        {injected}
        <Box justifyContent="flex-end">
          <Button
            key="clear"
            label="Clear log"
            variant="secondary"
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
