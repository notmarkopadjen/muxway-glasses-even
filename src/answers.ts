// The fixed set of answers the glasses can send. Nothing else leaves the
// glasses; free text comes from the phone.

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
  answer('Tab', [{ key: 'Tab' }]),
  answer('Shift-Tab', [{ key: 'BTab' }]),
  answer('Up', [{ key: 'Up' }]),
  answer('Down', [{ key: 'Down' }]),
]
