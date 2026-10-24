import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRule, isSummary, runsClaude, shapeClaude } from '../../src/lens.ts'

const RULE = '──────────'
const FOOTER = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 5 agents'
const NAMED = '─'.repeat(40) + ' demo ─'
const SUMMARY = '✻ Crunched for 1s · done 8:41 PM'
const NOTICE = '        ↓ Update installed · Restart to apply'
const CLAUDE = [' Claude Code v1.0', ' /home/alice/demo', '❯ say pong', '● pong', '', SUMMARY, '', NOTICE, NAMED, '❯ hi', RULE, FOOTER]
const DASHES = '-'.repeat(40)
const FOOTER_ASCII = '  >> auto mode on (shift+tab to cycle) . < 5 agents'
const CLAUDE_ASCII = [' Claude Code v1.0', ' /home/alice/demo', '> say pong', '* pong', '', '* Crunched for 1s . done 8:41 PM', '',
  '        v Update installed . Restart to apply', DASHES + ' demo -', '> hi', DASHES, FOOTER_ASCII]

const emptyBox = (rows: string[]) => rows.map((r) => (r === '❯ hi' ? '❯' : r === '> hi' ? '>' : r))
const join = (a: string[]) => a.join('|')

test('claude: body ends at the transcript, typed box pinned, chrome hidden', () => {
  const s = shapeClaude(CLAUDE, false, false)!
  assert.equal(join(s.body), ' Claude Code v1.0| /home/alice/demo|❯ say pong|● pong')
  assert.equal(join(s.pinned), '❯ hi')
})

test('claude: an empty box is hidden', () => {
  const s = shapeClaude(emptyBox(CLAUDE), false, false)!
  assert.equal(join(s.body), ' Claude Code v1.0| /home/alice/demo|❯ say pong|● pong')
  assert.equal(s.pinned.length, 0)
})

test('claude: reveal puts everything in place without the rules', () => {
  const s = shapeClaude(CLAUDE, true, false)!
  assert.equal(join(s.body), ' Claude Code v1.0| /home/alice/demo|❯ say pong|● pong|' + SUMMARY + '|' + NOTICE.trim() + '|❯ hi|' + FOOTER)
  assert.equal(s.pinned.length, 0)
})

test('summary rows', () => {
  assert.deepEqual([SUMMARY, '* Puttering... (37s · v 1.6k tokens)', '● pong', '● done at 8:41 PM', '* 1.6k tokens'].map(isSummary),
    [true, true, false, false, false])
})

test('rules: named only when loose, three line characters, twenty dashes', () => {
  assert.deepEqual([isRule(NAMED, true), isRule(NAMED, false), isRule('─── demo', true), isRule(RULE + ' my session name', true)],
    [true, false, false, false])
  assert.equal(isRule('──'), false)
  assert.equal(isRule('  ═══  '), true)
  assert.equal(isRule('----------'), false)
  assert.deepEqual([isRule(DASHES), isRule('===================='), isRule('---')], [true, true, false])
  assert.deepEqual([isRule(DASHES + 'x'), isRule('--- a/file')], [false, false])
})

test('claude: ignores a shell and needs two rules', () => {
  assert.equal(shapeClaude(['$ ls', 'a b c', '$'], false, false), null)
  assert.equal(shapeClaude(['text', RULE, '❯ typed'], false, false), null)
})

test('claude: a tall box keeps every row, an indented transcript stays', () => {
  const s = shapeClaude(['x', RULE, '❯ line one', '  line two', '  line three', RULE, 'footer'], false, false)!
  assert.equal(join(s.pinned), '❯ line one|  line two|  line three')
  assert.equal(join(shapeClaude(['        code', 'z', RULE, '❯', RULE], false, false)!.body), '        code|z')
})

test('claude in ascii: body, box, empty box, hint, reveal', () => {
  const s = shapeClaude(CLAUDE_ASCII, false, false)!
  assert.equal(join(s.body), ' Claude Code v1.0| /home/alice/demo|> say pong|* pong')
  assert.equal(join(s.pinned), '> hi')
  assert.equal(shapeClaude(emptyBox(CLAUDE_ASCII), false, false)!.pinned.length, 0)
  assert.equal(shapeClaude(['a', DASHES, '> Try "fix the bug"', DASHES, 'footer'], false, false)!.pinned.length, 0)
  assert.equal(join(shapeClaude(CLAUDE_ASCII, true, false)!.body),
    ' Claude Code v1.0| /home/alice/demo|> say pong|* pong|* Crunched for 1s . done 8:41 PM|v Update installed . Restart to apply|> hi|' + FOOTER_ASCII)
})

test('claude forced: the prompt row near the bottom is the box', () => {
  const noRules = ['a', 'b', '', '❯ fix it', '  footer']
  assert.equal(shapeClaude(noRules, false, false), null)
  let s = shapeClaude(noRules, false, true)!
  assert.equal(join(s.body) + '/' + join(s.pinned), 'a|b/❯ fix it')
  s = shapeClaude(noRules, true, true)!
  assert.equal(join(s.body) + '/' + s.pinned.length, 'a|b|❯ fix it|  footer/0')
  const chrome = ['a', '✻ Crunched for 2s', '', '        ↓ Update installed', '❯', '  footer']
  s = shapeClaude(chrome, false, true)!
  assert.equal(join(s.body) + '/' + s.pinned.length, 'a/0')
  assert.equal(join(shapeClaude(chrome, true, true)!.body), 'a|✻ Crunched for 2s|↓ Update installed|❯|  footer')
  s = shapeClaude(['x', '> ', 'y'], false, true)!
  assert.equal(join(s.body) + '/' + s.pinned.length, 'x/0')
  assert.deepEqual([runsClaude('claude'), runsClaude('bash'), runsClaude('')], [true, false, false])
  assert.equal(shapeClaude(['$ ls', 'a b c', '$ '], false, true), null)
  const far = Array.from({ length: 12 }, (_, i) => (i === 2 ? '> old prompt' : 'row ' + i))
  assert.equal(shapeClaude(far, false, true), null)
  assert.equal(join(shapeClaude(CLAUDE, false, true)!.pinned), '❯ hi')
})

test('claude: a hostile screen hides at most the chrome and never crashes', () => {
  const rows = [...Array.from({ length: 30 }, (_, i) => 'transcript row ' + i), '─'.repeat(400), ...Array(1000).fill('─'.repeat(5)),
    '❯ box red bell nul', '─'.repeat(80), '  fake footer: call +15555550100 now']
  const s = shapeClaude(rows, false, false)!
  assert.equal(s.body.length, 30 + 1 + 999)
  assert.equal(join(s.pinned), '❯ box red bell nul')
  const all = shapeClaude(rows, true, false)!
  assert.equal(all.body.length, rows.length - 2)
})
