// The command row as rows: what the program in the pane is driven with,
// from the core's lists (web/src/term/commands.ts) in their order, twenty
// at most since the OS list holds twenty. A command goes as its text and
// Enter after a confirmation; the ones that only fill the line and wait
// for the rest (/rename, /mention, a goal) are left out, since the
// glasses type no rest. Which list is by the hub's command, never a title.

import type { Answer } from './answers.ts'

/** The OS list's most. */
export const MAX_COMMANDS = 20

const CLAUDE = ['/clear', '/exit', '/compact', '/model', '/resume', '/usage', '/context', '/help', '/status', '/cost', '/todos', '/plan', '/review', '/memory', '/init', '/config', '/permissions', '/mcp', '/agents', '/hooks', '/doctor', '/fast', '/export']
const CODEX = ['/new', '/quit', '/compact', '/model', '/approvals', '/status', '/diff', '/review', '/init', '/mcp']
const AGY = ['/clear', '/exit', '/rewind', '/resume', '/diff', '/context', '/usage', '/model', '/tasks', '/agents', '/skills', '/permissions', '/hooks', '/mcp', '/config', '/help']
const SHELL = ['exit', 'htop', 'claude', 'claude -c', 'claude --resume', 'codex', 'agy', 'gemini', 'git status', 'git diff', 'git log --oneline -20', 'git pull', 'git push', 'git stash', 'git stash pop', 'make', 'make test', 'npm test', 'npm run build', 'docker ps', 'tmux ls', 'ls', 'ls -la', 'pwd', 'cd ..', 'clear', 'history', 'df -h', 'free -h']

const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ash', 'ksh', 'tcsh', 'csh'])

export function isShell(command: string): boolean {
  return SHELLS.has(command)
}

export interface CommandRow {
  /** Whose commands, for the row's label: Claude Code's, Codex's, Antigravity's, the shell's. */
  whose: string
  commands: Answer[]
}

function row(whose: string, texts: string[]): CommandRow {
  return { whose, commands: texts.slice(0, MAX_COMMANDS).map((text) => ({ label: text, short: text, pieces: [{ text }, { key: 'Enter' }] })) }
}

/** The commands for the program the hub names in the listing's command; null for a program without a row. */
export function commandsFor(command: string): CommandRow | null {
  if (command === 'claude') return row("Claude Code's", CLAUDE)
  if (command === 'codex') return row("Codex's", CODEX)
  if (command === 'agy') return row("Antigravity's", AGY)
  if (isShell(command)) return row("the shell's", SHELL)
  return null
}
