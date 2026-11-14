import { expect, test } from 'claude-code/testing'

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
    expect(t?.text).toBe('12%')
    await ui.unmount()
  }
})
