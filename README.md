# context-lens

A Claude Code mod that adds a **Context lens** pane beside the chat, showing what goes into the model's context beyond the built-in /context breakdown:

- **Loaded at start** – CLAUDE.md / memory files loaded at startup, by tier, with `@import` children and token estimates.
- **Loaded later** – nested CLAUDE.md files pulled in mid-session, and every time the agent Reads or Writes a CLAUDE.md / MEMORY.md / memory file, with timestamps.
- **Injected by harness** – every attachment the engine injects (system reminders, listings, hook output), grouped by type with counts and tokens.
- **Per turn** – total tokens after each turn, delta (red if > 20k), tool calls.

Reopen with `/ctx-lens`.

## Open files in Obsidian (optional)

Obsidian only opens files inside a vault. Set `obsidianVault` to a vault's absolute path and file names become clickable: the file is symlinked into `<vault>/<obsidianFolder>` (default `_claude`, dot-folders renamed since Obsidian hides them) and opened via `obsidian://`. Set it in `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "context-lens@context-lens": { "options": { "obsidianVault": "/path/to/vault" } }
}
``` Token figures for files and injections are rough estimates (chars / 4).

## Install

At the prompt of a terminal session:

```
/plugin install context-lens --marketplace manoharlk/context-lens
```

From a shell:

```bash
claude plugin install context-lens --marketplace manoharlk/context-lens
```

Answer `y` to add the marketplace, then pick a scope (user = every session).

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `manoharlk/context-lens`, then Add plugin.

## License

MIT
