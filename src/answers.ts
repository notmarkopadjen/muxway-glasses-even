// The fixed set of answers the glasses can send. Nothing else leaves the
// glasses; free text comes from the phone.

export interface Piece {
  text?: string
  key?: string
}

export interface Answer {
  label: string
  pieces: Piece[]
}

export const ANSWERS: readonly Answer[] = [
  { label: '⏎ Enter', pieces: [{ key: 'Enter' }] },
  { label: 'y ⏎', pieces: [{ text: 'y' }, { key: 'Enter' }] },
  { label: 'n ⏎', pieces: [{ text: 'n' }, { key: 'Enter' }] },
  { label: "1 · Claude Code's first choice", pieces: [{ text: '1' }] },
  { label: '2 · second choice', pieces: [{ text: '2' }] },
  { label: '3 · third choice', pieces: [{ text: '3' }] },
  { label: 'Esc', pieces: [{ key: 'Escape' }] },
  { label: 'Ctrl-C', pieces: [{ key: 'C-c' }] },
  { label: 'Tab', pieces: [{ key: 'Tab' }] },
  { label: 'Shift-Tab', pieces: [{ key: 'BTab' }] },
  { label: '↑ Up', pieces: [{ key: 'Up' }] },
  { label: '↓ Down', pieces: [{ key: 'Down' }] },
]

/** The answer in a few characters, for the confirmation and the flash: "y ⏎", "Ctrl-C". */
export function short(a: Answer): string {
  return a.label.split(' · ')[0]
}
