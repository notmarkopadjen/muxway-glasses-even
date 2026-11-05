// The fixed set of answers the glasses can send: the eight used most on
// the answers page, the console keys on a list of their own. Nothing else
// leaves the glasses but a command of the program's row (commands.ts);
// free text comes from the phone or the voice.

export interface Piece {
  text?: string
  key?: string
}

export interface Answer {
  label: string
  /** The answer in a few characters, for the confirmation and the flash: "y, Enter", "Ctrl-C". The firmware font has no ⏎. */
  short: string
  pieces: Piece[]
  /** A choice of a question asked with muxway ask: it goes to the asking process, not into the pane. */
  choice?: string
  /** Pane text sent back (Claude's suggestion): the log keeps its size, not its words. */
  secret?: boolean
}

function answer(label: string, pieces: Piece[], short = label): Answer {
  return { label, short, pieces }
}

/** A question's choice as an answer row: » yes. */
export function choiceAnswer(choice: string): Answer {
  return { label: '» ' + choice, short: choice, pieces: [], choice }
}

export const ANSWERS: readonly Answer[] = [
  answer('Enter', [{ key: 'Enter' }]),
  answer('y, Enter', [{ text: 'y' }, { key: 'Enter' }]),
  answer('n, Enter', [{ text: 'n' }, { key: 'Enter' }]),
  answer("1 · Claude Code's first choice", [{ text: '1' }], '1'),
  answer('2 · second choice', [{ text: '2' }], '2'),
  answer('3 · third choice', [{ text: '3' }], '3'),
  answer('Esc', [{ key: 'Escape' }]),
  answer('Ctrl-C', [{ key: 'C-c' }]),
]

/** The console keys, in the guideline's order; the six that need the key grammar are marked. */
const CONSOLE: readonly (Answer & { grammar?: boolean })[] = [
  answer('Up', [{ key: 'Up' }]),
  answer('Down', [{ key: 'Down' }]),
  { ...answer('Left', [{ key: 'Left' }]), grammar: true },
  { ...answer('Right', [{ key: 'Right' }]), grammar: true },
  { ...answer('PageUp', [{ key: 'PageUp' }]), grammar: true },
  { ...answer('PageDown', [{ key: 'PageDown' }]), grammar: true },
  { ...answer('Home', [{ key: 'Home' }]), grammar: true },
  { ...answer('End', [{ key: 'End' }]), grammar: true },
  answer('Tab', [{ key: 'Tab' }]),
  answer('Shift-Tab', [{ key: 'BTab' }]),
  answer('Enter', [{ key: 'Enter' }]),
  answer('Esc', [{ key: 'Escape' }]),
]

/** The keys list: every console key on a host whose agent takes the key grammar, else the ones every agent takes. */
export function keysFor(grammar: boolean): Answer[] {
  return CONSOLE.filter((k) => grammar || !k.grammar).map(({ grammar: _g, ...k }) => k)
}
