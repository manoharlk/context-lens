export type Load = {
  at: number
  path: string
  how: 'startup' | 'import' | 'nested' | 'read' | 'write'
  kind: string
  parent?: string
  tokens: number
}
export type Inject = { at: number; type: string; tokens: number; origin: string }
export type Turn = { at: number; tokens: number; delta: number; tools: number }

declare module 'claude-code' {
  interface PluginState {
    'context-lens': {
      loads: Shaped<Load[]>
      injects: Shaped<Inject[]>
      turns: Shaped<Turn[]>
    }
  }
}
