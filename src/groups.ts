// Groups: panes that talked to each other in the last ten minutes, the
// partners of partners too, from the listing's talk alone. The core's
// web client does the same; a group is numbered by its first member in
// the panes' order.

import type { Pane } from './protocol.ts'

export type Groups = Map<string, number>

export function groupsOf(panes: Pane[]): Groups {
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  for (const p of panes) for (const partner of p.talk) union(p.address, partner)
  const groups: Groups = new Map()
  const numbers = new Map<string, number>()
  for (const p of panes) {
    if (!parent.has(p.address)) continue
    const root = find(p.address)
    // A pane whose partners are all out of the listing forms no group.
    const members = panes.filter((q) => parent.has(q.address) && find(q.address) === root)
    if (members.length < 2) continue
    let n = numbers.get(root)
    if (n === undefined) {
      n = numbers.size + 1
      numbers.set(root, n)
    }
    groups.set(p.address, n)
  }
  return groups
}

/** The members of a group right after its first member in the rows' order; everything else keeps its place. */
export function pullTogether<T extends { address: string }>(rows: T[], groups: Groups): T[] {
  const out: T[] = []
  const done = new Set<string>()
  for (const r of rows) {
    if (done.has(r.address)) continue
    out.push(r)
    done.add(r.address)
    const g = groups.get(r.address)
    if (g === undefined) continue
    for (const s of rows)
      if (!done.has(s.address) && groups.get(s.address) === g) {
        out.push(s)
        done.add(s.address)
      }
  }
  return out
}
