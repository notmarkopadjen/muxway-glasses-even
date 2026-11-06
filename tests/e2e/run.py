"""
The end-to-end suite. Usage: run.py <run directory> <muxway binary> [test id ...]
Security tests first, then the features; the phone pane's tests run in
Chromium through Playwright (tests/e2e/phone.mjs).
"""

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import xml.sax.saxutils as sax
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402
from harness import HOST, Core, Failure, Proxy, Sim, Static, Transcriber, check, direct, wait_for, words  # noqa: E402

TESTS = []


def test(tid, title, kind):
    def register(fn):
        TESTS.append({"id": tid, "title": title, "kind": kind, "fn": fn})
        return fn
    return register


class Run:
    def __init__(self, out, binary):
        self.out = Path(out)
        self.binary = binary
        self.tmp = tempfile.mkdtemp(prefix="mxw-glasses-")
        os.chmod(self.tmp, 0o700)
        self.secrets = []
        self.shots = {}
        self.cleanups = []
        # A display nobody holds: Xvfb fails quietly on a taken one, and every
        # simulator then times out.
        n = 90 + os.getpid() % 900
        while os.path.exists(f"/tmp/.X{n}-lock"):
            n += 1
        self.display = f":{n}"
        self.xvfb = subprocess.Popen(["Xvfb", self.display, "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        self.static = Static()

    def logs(self, test):
        p = self.out / "logs" / test
        p.mkdir(parents=True, exist_ok=True)
        return p

    def screens(self, test):
        p = self.out / "screens" / test
        p.mkdir(parents=True, exist_ok=True)
        return p

    def add_shot(self, test, path):
        self.shots.setdefault(test, []).append(path)

    def close(self):
        self.static.close()
        self.xvfb.terminate()
        shutil.rmtree(self.tmp, ignore_errors=True)


def setup(run, name, mode="normal", expose="--write", read=f"{HOST}/*", write=f"{HOST}/*", params=None,
          revoke=False, before=None, says_claude=False, says=None, token=None, stt=False, preview=False, sessions=False, close=False,
          stt_text="run the tests again"):
    logs = run.logs(name)
    hub_args = []
    transcriber = None
    if stt:
        transcriber = Transcriber(logs, stt_text)
        run.cleanups.append(transcriber.close)
        hub_args = ["--stt-url", transcriber.url, "--stt-model", "whisper-base.en", "--stt-prompt", f"{HOST}, muxway"]
    core = Core(run, run.binary, logs, hub_args)
    if sessions:
        core.agent_args.append("--allow-sessions")
    if close:
        core.agent_args.append("--allow-close")
    if preview:
        # A preview root with one folder in it, for a pane that works there.
        core.preview = core.dir / "preview"
        (core.preview / "src").mkdir(parents=True)
        core.agent_args += ["--preview", str(core.preview)]
    core.start(expose=expose)
    core.transcriber = transcriber
    run.cleanups.append(core.close)
    tok = core.token(read=read, write=write)
    if revoke:
        core.revoke_all()
    proxy = Proxy(core.url, logs, mode)
    proxy.says = "claude" if says_claude else says
    run.cleanups.append(proxy.close)
    if before:
        before(core)
    all_params = {"hub": proxy.url, "token": token or tok, "every": 1}
    if stt or mode.startswith("stt-"):
        all_params["mic"] = "tone"
    all_params.update(params or {})
    sim = Sim(run, name, run.static.url, all_params)
    run.cleanups.append(sim.close)
    return core, proxy, sim, tok


def allrows(p):
    """Every row of a page of the app's own rows (the list, the inbox, the messages, the mail), without the cursor mark and the blank ones."""
    return [line[2:] for b in p["blocks"] if b.get("name", "").startswith("rows") for line in b["lines"] if line.strip()]


def rows(p):
    """The pane list's rows on screen without the host lines, which the tests of one host take for granted (F63 reads
    them), and with a shell's activity word, active for ten seconds and then quiet with its age, read as quiet."""
    return [re.sub(r" · (active|quiet \d+[smhd])\b", " · quiet", r) for r in allrows(p) if not r.startswith("── ")]


def inbox_rows(p):
    """The inbox page's entries: their first rows, without the notice rows under them."""
    return [r for r in allrows(p) if not r.startswith("    ")]


def inbox_pick(sim, n):
    """On the inbox page: the cursor n entries down, then a tap."""
    for _ in range(n):
        sim.scroll("down", 0.5)
    sim.tap()


def following(sim):
    """The pane page follows at the bottom: its state is the pane's place, with read-only in front for a reader."""
    return re.fullmatch(r"(read-only · )?[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.\d+|read-only", sim.state()) is not None


def listed(p):
    """The pane list with the panes in it, not the loading row."""
    return p["kind"] == "dash" and bool(rows(p)) and not rows(p)[0].startswith("reading the hub") and not p["hint"].startswith("reading the hub")


def total(p):
    """How many rows the list has: the hint says it when they do not fit, else they are all on screen."""
    m = re.search(r"\d+–\d+ of (\d+) · ", p["hint"])
    return int(m.group(1)) if m else len(rows(p))


def home(sim, timeout=25):
    """The pane list once the first listing is in: a gesture before that lands while the page is
    still being built and is dropped."""
    return sim.expect(listed, "the first listing", timeout)


def open_pane(sim, name="test-pane"):
    """From the start: a tap on the list's first row opens that pane."""
    home(sim)
    sim.shot("list")
    sim.pick(0)
    page = sim.expect(lambda p: any(b.get("name") == "title" and name in b["lines"][0] for b in p["blocks"]), "the pane")
    wait_for("the pane's rows", lambda: following(sim) or "paused" in sim.state(), 10)
    sim.shot("pane")
    return page


def open_list(sim):
    """From the start: the list is the first page."""
    return home(sim)


def to_split(sim, held=(0, 1)):
    """From the start: hold the rows, then tap the open row under the panes."""
    page = home(sim)
    n = len(rows(page))
    sim.hold(held[0])
    sim.expect(lambda p: listed(p) and rows(p)[held[0]].startswith("[x] "), f"row {held[0]} selected")
    for i in held[1:]:
        sim.pick(i)
        sim.expect(lambda p: listed(p) and rows(p)[i].startswith("[x] "), f"row {i} selected")
    sim.pick(n)
    return sim.expect(lambda p: p["kind"] == "dash" and col(p, 1) is not None, "the columns")


def col(page, i):
    for b in page["blocks"]:
        if b.get("name") == f"col{i}":
            return b
    return None


def titles(page):
    """The title lines on the page: the pane's, or the columns' in order."""
    return [b["lines"][0] for b in page["blocks"] if b.get("name", "").startswith("title")]


# --- security -----------------------------------------------------------------------

@test("S01", "Wrong and revoked tokens: refused once, forgotten, no retry", "e2e-security")
def s01(run, name):
    core, proxy, sim, tok = setup(run, name, revoke=True)
    sim.head("token refused", "the refusal", 20)
    sim.shot("refused")
    time.sleep(6)
    sim.web("phone-after-refusal")
    tried = [r for r in proxy.requests if r["headers"].get("Authorization") == "Bearer " + tok]
    check(1 <= len(tried) <= 3, f"the revoked token was tried {len(tried)} times")
    check(time.time() - max(r["at"] for r in tried) > 4, "the app went on trying a refused token")
    check(not any(tok in r["path"] for r in proxy.requests), "the token appeared in a URL")
    sim.close()
    run.cleanups.remove(sim.close)
    wrong = "mxt_" + "x" * 43
    before = len(proxy.requests)
    sim2 = Sim(run, name, run.static.url, {"hub": proxy.url, "token": wrong, "every": 1})
    run.cleanups.append(sim2.close)
    sim2.head("token refused", "the refusal of a wrong token", 20)
    time.sleep(5)
    tried = [r for r in proxy.requests[before:] if r["headers"].get("Authorization") == "Bearer " + wrong]
    check(1 <= len(tried) <= 3, f"the wrong token was tried {len(tried)} times")


@test("S03", "Read-only token: no answers, a direct write is refused", "e2e-security")
def s03(run, name):
    core, proxy, sim, tok = setup(run, name, write=None)
    page = open_list(sim)
    check(any("read-only" in i for i in rows(page)), f"no read-only mark: {rows(page)}")
    sim.shot("list")
    sim.pick(0)
    page = sim.head("test-pane", "the pane")
    wait_for("following", lambda: following(sim), 10)
    page = sim.last()
    check("refresh" in page["hint"] and "answer" not in page["hint"], f"hint offers an answer: {page['hint']}")
    sim.tap()
    time.sleep(1.5)
    check(sim.last()["kind"] == "dash", "a tap on a read-only pane opened a list")
    sim.shot("pane")
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/input", '{"text":"y"}')
    check(status == 403, f"a direct write got {status}")
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") and r["headers"].get("Origin") is not None for r in proxy.requests), "the app wrote")


@test("S04", "A 1 MiB body, bytes that are not UTF-8 and control characters", "e2e-security")
def s04(run, name):
    for mode in ("big", "garbage"):
        test_name = f"{name}-{mode}"
        core, proxy, sim, tok = setup(run, test_name, mode=mode)
        open_pane(sim)
        lines = sim.lines()
        text = "".join(lines)
        check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", text), "control characters reached the screen")
        if mode == "big":
            check(all(len(l) < 200 for l in lines), "a line longer than the screen")
            check(text.startswith("x" * 8), f"the big body was not shown: {lines[:2]}")
        else:
            check("end" in text and "bell" in text and "nul" in text, f"the garbage body was not shown cleanly: {lines}")
        n = len(proxy.paths("/v1/panes/"))
        wait_for("the app still polls", lambda: len(proxy.paths("/v1/panes/")) > n, 6)
        check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")
        sim.shot("shown")
        for fn in reversed(run.cleanups):
            fn()
        run.cleanups.clear()


@test("S05", "Hostile Claude Code screen: at most the chrome hidden, the box offered clean and sent as printable text only, reveal shows all", "e2e-security")
def s05(run, name):
    core, proxy, sim, tok = setup(run, name, mode="claude-hostile", params={"charset": "utf-8"}, says_claude=True)
    open_pane(sim)
    page = sim.last()
    check(not any("bell" in l for l in sim.lines()), "the box is on the pane")
    check(not any("fake footer" in l for l in sim.lines()), "the footer was shown unasked")
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(page)), "control characters reached the screen")
    sim.shot("hostile")
    sim.menu(0)
    sim.expect(lambda p: any("fake footer" in l for b in p["blocks"] for l in b["lines"]), "reveal all", 10)
    sim.shot("revealed")
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    offer = page["items"][0]
    check(offer.startswith('» "box ') and "bell" in offer, f"the box is not the first answer: {page['items'][:2]}")
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", offer) and len(offer.encode()) <= 63, offer)
    sim.shot("hostile-offer")
    sim.choose(0)
    page = sim.head("send this to test-pane?", "the confirmation")
    shown = " ".join(sim.block("text", page) or [])
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", shown), "control characters on the confirmation")
    sim.shot("hostile-confirm")
    sim.tap()
    sim.head('sent "box', "the flash", 10)
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(posts == [{"text": "box [31mred[0m bell nul"}, {"key": "Enter"}], str(posts))
    check(posts[0]["text"] == shown, f"sent {posts[0]['text']!r}, showed {shown!r}")
    check(all(r["path"].startswith("/v1/panes/alice-laptop/work/0.0/") for r in proxy.requests if r["method"] == "POST"), "a write to another pane")
    check(not any("bell" in e["message"] for e in sim.console()), "the box's text in the console")
    check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")


@test("S06", "Hostile events: escapes and 10 KiB of text become one fitted toast; a bad cursor restarts", "e2e-security")
def s06(run, name):
    core, proxy, sim, tok = setup(run, name, mode="events-hostile")
    page = sim.expect(lambda p: p.get("hintBorder") and p["hintLevel"] == 4, "the toast", 30)
    check(page["hint"].startswith("★ test-pane: needs "), f"toast: {page['hint'][:80]}")
    check(len(page["hint"]) <= 260 and "\x1b" not in page["hint"] and "\x07" not in page["hint"], "the toast is not clean")
    sim.shot("toast")
    wait_for("a restart without a cursor", lambda: len(proxy.paths("/v1/events?limit=50")) >= 2, 20)
    wait_for("polling goes on", lambda: len([r for r in proxy.requests if r["method"] == "GET" and r["path"].startswith("/v1/events?after=")]) >= 3, 20)
    check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")


@test("S07", "Pane titles with a forged mark, a tab, 300 characters and wide glyphs: rows clamped, marks their own", "e2e-security")
def s07(run, name):
    core, proxy, sim, tok = setup(run, name, mode="lie-title")
    page = open_list(sim)
    items = rows(page)
    check(len(items) == 5, f"rows: {items}")
    for row in items:
        check(not row.startswith("[x] "), f"a title selected itself: {row}")
    check(items[0].startswith("◌ bash · ★ "), f"the forged mark became the pane's: {items[0]}")
    check("read-only" in items[0] or items[0].endswith("…"), f"the forged mode was believed: {items[0]}")
    check(items[1].startswith("◌ bash · tab here"), f"the tab survived as a tab: {items[1]}")
    check(not any(r.startswith("★") for r in items), f"a title raised attention: {items}")
    time.sleep(1)
    sim.shot("rows")
    check(not any("refused" in e["message"] for e in sim.console()), "the firmware refused the page")


@test("S08", "The suggestion: none from a shell's rules or from a box too long to show whole; what Claude's box sends is what the confirmation showed", "e2e-security")
def s08(run, name):
    def answers(sim):
        open_pane(sim)
        sim.tap()
        return sim.head("answer test-pane", "the answers")

    def no_writes(proxy):
        check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "the app wrote")

    def teardown():
        for fn in reversed(run.cleanups):
            fn()
        run.cleanups.clear()

    # A shell that printed two rules around a command: the hub says bash, so no suggestion.
    core, proxy, sim, tok = setup(run, f"{name}-shell", mode="shell-rules")
    page = answers(sim)
    check(page["items"][0] == "Enter" and not any(i.startswith("»") for i in page["items"]), f"a shell's rows were offered: {page['items'][:2]}")
    sim.shot("shell-answers")
    no_writes(proxy)
    teardown()
    # Claude's box, longer than the confirmation can show whole: not offered at all.
    core, proxy, sim, tok = setup(run, f"{name}-long", mode="claude-long", says_claude=True)
    page = answers(sim)
    check(page["items"][0] == "Enter" and not any(i.startswith("»") for i in page["items"]), f"a long box was offered: {page['items'][:2]}")
    sim.shot("long-answers")
    no_writes(proxy)
    teardown()
    # Claude's box: the confirmation shows every word, and those words are what is sent.
    core, proxy, sim, tok = setup(run, f"{name}-claude", mode="claude", says_claude=True)
    page = answers(sim)
    check(page["items"][0].startswith('» "'), f"no suggestion: {page['items'][:2]}")
    sim.choose(0)
    page = sim.head("send this to test-pane?", "the confirmation")
    check(page["kind"] == "dash" and page["items"] == [], "the confirmation is a list")
    shown = " ".join(sim.block("text", page) or [])
    check(shown == "fix the typo in README", f"the box shows {shown!r}")
    sim.shot("claude-confirm")
    sim.tap()
    sim.head("sent ", "the flash", 10)
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(posts == [{"text": shown}, {"key": "Enter"}], f"sent {posts}, showed {shown!r}")


@test("S02", "The token is in no URL, no console line and on no screen", "e2e-security")
def s02(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    time.sleep(2)
    check(not any(tok in r["path"] for r in proxy.requests), "the token appeared in a URL")
    check(all(r["headers"].get("Authorization") == "Bearer " + tok for r in proxy.requests if r["method"] != "OPTIONS"), "a request without the bearer token")
    text = "\n".join(e["message"] for e in sim.console())
    check(tok not in text, "the token appeared in the console")
    check(tok not in json.dumps(sim.trace()), "the token appeared on the glasses")
    sim.web("phone")


@test("S30", "A listing of 200 panes with long titles and times out of range: a page of rows, words clamped, page accepted", "e2e-security")
def s30(run, name):
    core, proxy, sim, tok = setup(run, name, mode="list-hostile")
    # Every one of the 200 claims attention, so the inbox row leads them, then the host's line: 202 rows.
    page = sim.expect(lambda p: listed(p) and total(p) == 202, "the 200 panes", 20)
    check(len(rows(page)) == 8, f"{len(rows(page))} rows")
    for row in rows(page):
        check("-" not in row.split("·")[-1], f"a negative age: {row}")
    check(rows(page)[0] == "◆ inbox · 200 waiting", rows(page)[0])
    check(page["charts"] == [] and page["hint"].startswith("◆ 200 · 1–9 of 202 · "), f"the list page: {page['charts']} {page['hint']}")
    sim.shot("hostile-list")
    sim.move(9)
    page = sim.expect(lambda p: listed(p) and sim.cursor(p) == 10 and p["blocks"][0]["name"] == "rows2", "the window slid")
    check(page["hint"].startswith("◆ 200 · 3–11 of 202 · "), page["hint"])
    sim.shot("hostile-list-slid")
    time.sleep(1)
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S31", "Pane JSON with a 1 MiB title and nested junk: parsed or skipped, polling goes on", "e2e-security")
def s31(run, name):
    core, proxy, sim, tok = setup(run, name, mode="list-junk")
    # The body is over the app's cap, so the listing is cut and parsed as empty, or parsed with the one pane: either is fine.
    page = sim.expect(lambda p: listed(p) and total(p) <= 2, "the listing survived", 20)
    check(all(len(row) < 200 for row in rows(page)), f"rows: {rows(page)}")
    n = len([r for r in proxy.requests if r["path"] == "/v1/panes"])
    wait_for("the list is read again", lambda: len([r for r in proxy.requests if r["path"] == "/v1/panes"]) > n, 15)
    check(not any("uncaught" in e["message"] for e in sim.console()), "an uncaught error")


# --- spoken replies -------------------------------------------------------------------

def say_it(sim, name="test-pane"):
    """From the pane: tap, the Say it row, the Listening page."""
    sim.tap()
    page = sim.head("answer " + name, "the answers")
    check(page["items"][0] == "» Say it", f"no Say it row: {page['items'][:2]}")
    sim.shot("answers-say")
    sim.choose(0)
    return sim.head("listening", "listening", 10)


@test("S40", "An answer needs a write grant and a writable pane: a read-only token is refused directly, a pane the proxy calls writable gets 403 on the glasses, and the ask still waits", "e2e-security")
def s40(run, name):
    # A token without a write grant, and a proxy that calls the pane writable all the same.
    core, proxy, sim, tok = setup(run, name, write=None, mode="lie-writable")
    open_pane(sim)
    ask = core.ask("deploy to staging?", ["yes", "no"])
    run.cleanups.append(ask.kill)
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/answer", '{"choice":"yes"}')
    check(status == 403, f"a read-only token's answer got {status}")
    # The glasses believe the proxy and offer the choices; the hub knows better.
    wait_for("the question on the pane", lambda: "asks a question" in sim.state(), 10)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][:2] == ["» yes", "» no"], page["items"][:3])
    sim.choose(0)
    sim.head("answer yes to test-pane?", "the confirmation")
    sim.choose(1)
    sim.head("read only", "the refusal", 10)
    sim.shot("refused")
    check(ask.poll() is None, "the ask ended although nothing answered it")
    posts = [r for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/answer") and r["headers"].get("Origin") is not None]
    check(len(posts) == 1 and json.loads(posts[0]["body"]) == {"choice": "yes"}, str([(p["path"], p["body"]) for p in posts]))
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "something was typed into the pane")
    ask.kill()


@test("S41", "Hostile choices from the proxy: nine of them, one too long, one with an escape, one with a bar: no choice rows, the page intact", "e2e-security")
def s41(run, name):
    core, proxy, sim, tok = setup(run, name, mode="choices-hostile")
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and rows(p)[1].startswith("★ bash · test-pane"), "the question in the list", 20)
    check(rows(page)[0] == "◆ inbox · 1 waiting", rows(page))
    sim.pick(1)
    sim.expect(lambda p: any(b.get("name") == "title" and "test-pane" in b["lines"][0] for b in p["blocks"]), "the pane")
    wait_for("the pane's rows", lambda: "asks a question" in sim.state(), 10)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(not any(i.startswith("» ") and i != "» Say it" for i in page["items"]), f"a hostile choice became a row: {page['items'][:4]}")
    check(page["items"][0] == "Enter", page["items"][:2])
    check(not any("\x1b" in i or "|" in i for i in page["items"]), "a choice reached the page")
    sim.shot("answers-no-choices")
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S42", "An answer when nothing waits any more: 409, said in words; a choice the hub did not offer: 400", "e2e-security")
def s42(run, name):
    core, proxy, sim, tok = setup(run, name)
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/answer", '{"choice":"yes"}')
    check(status == 409, f"an answer to no question got {status}")
    open_pane(sim)
    ask = core.ask("deploy to staging?", ["yes", "no"])
    run.cleanups.append(ask.kill)
    wait_for("the question on the pane", lambda: "asks a question" in sim.state(), 10)
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/answer", '{"choice":"maybe"}')
    check(status == 400, f"a choice not offered got {status}")
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][:2] == ["» yes", "» no"], page["items"][:3])
    # Answered elsewhere while the glasses still show the choices: the hub says so.
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/answer", '{"choice":"no"}')
    check(status == 204, f"the direct answer got {status}")
    check(ask.wait(10) == 0 and ask.stdout.read().strip() == "no", "the ask did not get the direct answer")
    sim.choose(0)
    sim.head("answer yes to test-pane?", "the confirmation")
    sim.choose(1)
    sim.head("no question there now", "the words", 10)
    sim.shot("no-question")


@test("S50", "Hostile talk, mail, cwd and alias from the proxy: 600 partners, one of 300 characters, a lone pane's unlisted partner, counts of a billion, minus one and a string, a cwd of 10 000 characters with control bytes, one that is no string, one of slashes, an alias of 300: rows within the budget, the bar only where both panes are listed, the page accepted", "e2e-security")
def s50(run, name):
    core, proxy, sim, tok = setup(run, name, mode="talk-hostile")
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "three rows", 20)
    # The first pane's cwd is cut to 256 characters, so its folder is whatever segment the cut leaves; it shows only if the row has room.
    check(re.fullmatch(r"│ ◌ bash · test-pane · mail 999 · (/\S+ · )?.*", rows(page)[0]), rows(page))
    check(rows(page)[1].startswith("│ ◌ bash · build · "), rows(page))
    check(rows(page)[2].startswith("◌ " + "a" * 32 + " · bash · lone · "), rows(page))
    check(all(len(r.encode()) <= 63 for r in rows(page)), [len(r.encode()) for r in rows(page)])
    check(all(c >= " " for r in rows(page) for c in r), "a control byte in a row")
    check("mail" not in page["hint"] and not page.get("hintBorder"), page["hint"])
    sim.shot("talk-hostile")
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S51", "A read-only token on a pane under the agent's preview root: the hub gives no cwd, the row and the title show no folder", "e2e-security")
def s51(run, name):
    def before(core):
        core.new_window("notes", title="notes.md", cwd=core.preview / "src", alias="notes")
    core, proxy, sim, tok = setup(run, name, write=None, preview=True, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "two rows", 20)
    check(rows(page) == ["◌ bash · test-pane · quiet · read-only", "◌ notes · bash · notes.md · quiet · read-only"], rows(page))
    status, body = direct(proxy.url, tok, "GET", "/v1/panes", accept="application/json")
    check(status == 200 and b"cwd" not in body, f"the listing for a reader: {status} {body[:200]!r}")
    sim.shot("list-reader")
    sim.pick(1)
    sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] == "◌ notes · bash · notes.md" for b in p["blocks"]), "the title without a folder", 10)
    sim.shot("pane-reader")


@test("S52", "A read-only token on a parked pane: the mark and the word, no Later or Wake in the menu, no wake sent when it opens, a direct wake refused", "e2e-security")
def s52(run, name):
    def before(core):
        core.new_window("build")
        core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
        # Parked by a writer through the hub; the glasses' token only reads.
        writer = core.token(name="writer")
        status, body = direct(core.url, writer, "POST", f"/v1/panes/{HOST}/work/1.0/later", '{"later":true}')
        check(status == 204, f"parking as a writer got {status} {body[:100]!r}")
    core, proxy, sim, tok = setup(run, name, write=None, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3 and rows(p)[2].startswith("zz"), "three rows", 20)
    check(rows(page) == ["◆ inbox · 1 waiting", "◌ bash · test-pane · quiet · read-only", "zz bash · build · later · needs permission · read-only"], rows(page))
    sim.shot("list-reader")
    sim.pick(2)
    sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] == "zz bash · build" for b in p["blocks"]), "the parked pane", 10)
    wait_for("the state", lambda: sim.state() == "later · permission", 10)
    page = sim.last()
    check(not any(m["label"] in ("Later", "Wake") for m in page["menu"]), page["menu"])
    sim.shot("pane-reader")
    check(not any(r["method"] == "POST" and r["path"].endswith("/later") for r in proxy.requests), "a wake was sent for a reader")
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/1.0/later", '{"later":false}')
    check(status == 403, f"a reader's wake got {status} {body[:100]!r}")
    status, body = direct(proxy.url, tok, "GET", "/v1/panes", accept="application/json")
    build = next(p for p in json.loads(body)["panes"] if p["address"] == f"{HOST}/work/1.0")
    check(build.get("later") is True, f"the pane after the refused wake: {build}")


@test("S53", "Hostile later from the proxy: a flag of yes and of 1, a later_at of a string, minus one and 10^18, a parked pane with nothing pending, 200 parked panes: only true parks, the ages clamped, rows within the budget, the page accepted", "e2e-security")
def s53(run, name):
    core, proxy, sim, tok = setup(run, name, mode="later-hostile")
    page = sim.expect(lambda p: listed(p) and rows(p)[0].startswith("◆ inbox"), "the inbox row", 20)
    check(rows(page)[0] == "◆ inbox · 203 waiting", rows(page))
    check(page["hint"].startswith("◆ 203 · "), page["hint"])
    check(rows(page)[1].startswith("◌ bash · test-pane · ") and rows(page)[2].startswith("◌ bash · build · "), rows(page))
    check(all(r.startswith("zz ") and " · later" in r for r in rows(page)[3:]), rows(page))
    check(all(len(r.encode()) <= 63 for r in rows(page)), [len(r.encode()) for r in rows(page)])
    check(not page.get("hintBorder"), page["hint"])
    sim.shot("list-hostile")
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "dash" and p["hint"].startswith("inbox · 203 waiting"), "the inbox page", 10)
    items = allrows(page)
    check(len(items) == 9, len(items))
    check(items[0] == "zz bash · lone · later", items[:4])
    check(re.fullmatch(r"zz bash · old · later · needs permission · \d+s", items[1]), items[:4])
    check(items[2] == "    Claude needs your permission to use Bash", items[:4])
    check(re.fullmatch(r"zz bash · far · later · \d+s", items[3]), items[:4])
    check(all(len(r.encode()) <= 63 for r in items), [len(r.encode()) for r in items])
    sim.shot("inbox-hostile")
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S25", "No transcriber: no Say it row; a hub that offers one and then fails: an error line, nothing sent", "e2e-security")
def s25(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][0] == "Enter", f"a Say it row without a transcriber: {page['items'][0]}")
    sim.shot("answers-plain")
    for fn in reversed(run.cleanups):
        fn()
    run.cleanups.clear()
    core, proxy, sim, tok = setup(run, name + "-lies", mode="stt-lies")
    open_pane(sim)
    say_it(sim)
    time.sleep(1.5)
    sim.tap()
    page = sim.head("hub unreachable", "the error", 10)
    check("say it again" in page["hint"], page["hint"])
    sim.shot("stt-failed")
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "something was sent")


@test("S26", "A transcript with escapes and 10 KiB: shown cleaned and cut, only printable text sent", "e2e-security")
def s26(run, name):
    core, proxy, sim, tok = setup(run, name, mode="stt-hostile")
    open_pane(sim)
    say_it(sim)
    time.sleep(1.5)
    sim.tap()
    page = sim.head("heard this", "the transcript", 15)
    text = "".join(sim.block("text", page) or [])
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", text), "control characters on screen")
    check(text.startswith("run [31mthe tests"), text[:40])
    sim.shot("heard-hostile")
    sim.tap()
    sim.head("sent what you said", "the flash", 10)
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(len(posts) == 2 and "text" in posts[0] and posts[1] == {"key": "Enter"}, str(posts)[:200])
    sent = posts[0]["text"]
    check(not re.search(r"[\x00-\x1f\x7f]", sent) and len(sent.encode()) <= 4096, f"sent {len(sent)} chars")


@test("F20", "Say it: the tone is recorded, stopped, transcribed by the hub, read back and sent", "UI")
def f20(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True)
    open_pane(sim)
    say_it(sim)
    sim.shot("listening")
    time.sleep(2)
    page = sim.expect(lambda p: "listening" in sim.state() and any(c["key"].startswith("levels:") for c in p["charts"]), "the graph", 5)
    sim.shot("graph")
    sim.tap()
    page = sim.head("heard this", "the transcript", 15)
    check("run the tests again" in "".join(sim.block("text", page) or []), page["blocks"])
    sim.shot("heard")
    clips = core.transcriber.clips
    check(len(clips) == 1 and clips[0][:4] == b"RIFF" and len(clips[0]) > 44 + 2 * 16000, f"clip: {len(clips)} {len(clips[0]) if clips else 0}")
    sim.tap()
    sim.head("sent what you said", "the flash", 10)
    wait_for("typed", lambda: "run the tests again" in core.pane(), 5)
    sim.expect(lambda p: any("run the tests again" in l for l in (sim.block("body", p) or [])), "the pane after", 8)
    sim.shot("sent")
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(posts == [{"text": "run the tests again"}, {"key": "Enter"}], str(posts))
    hub = (run.logs(name) / "hub.log").read_text()
    check("audit transcribe" in hub and "run the tests again" not in hub, "the hub log")


@test("F21", "No frames for four seconds: the error page, the mic closed", "UI")
def f21(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True, params={"mic": ""})
    open_pane(sim)
    say_it(sim)
    page = sim.head("no audio from the mic", "the error", 10)
    check("say it again" in page["hint"], page["hint"])
    sim.shot("no-audio")
    check(not core.transcriber.clips, "a clip was sent")


@test("F22", "Say it again, Type without Enter, cancel by double tap", "UI")
def f22(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True)
    open_pane(sim)
    say_it(sim)
    time.sleep(1.5)
    sim.tap()
    sim.head("heard this", "the first transcript", 15)
    sim.menu(1)
    sim.head("listening", "listening again", 10)
    time.sleep(1.5)
    sim.tap()
    sim.head("heard this", "the second transcript", 15)
    check(len(core.transcriber.clips) == 2, f"{len(core.transcriber.clips)} clips")
    sim.shot("heard-again")
    sim.menu(0)
    sim.head("typed what you said", "typed without Enter", 10)
    wait_for("typed", lambda: "run the tests again" in core.pane(), 5)
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(posts == [{"text": "run the tests again"}], str(posts))
    core.keys("C-u")
    say_it(sim)
    time.sleep(1.5)
    sim.tap()
    sim.head("heard this", "the third transcript", 15)
    sim.back()
    wait_for("back on the pane", lambda: following(sim) or "paused" in sim.state(), 10)
    time.sleep(1)
    check(len([r for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]) == 1, "the cancelled transcript was sent")
    sim.shot("cancelled")


# --- features -------------------------------------------------------------------------

@test("F10", "Pane list with marks and read-only; nineteen rows and the next page", "UI")
def f10(run, name):
    def before(core):
        core.new_window("logs", expose=None)
        core.notify("done", "tests passed", "work:logs.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    # The done pane puts the inbox row first; the panes follow, those that wait before the rest.
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "three rows")
    check(rows(page)[0] == "◆ inbox · 1 waiting", f"rows: {rows(page)}")
    check(rows(page)[1].startswith("√ bash · logs") and rows(page)[1].endswith("· done · read-only"), f"rows: {rows(page)}")
    check(rows(page)[2].startswith("◌ bash · test-pane · quiet"), f"rows: {rows(page)}")
    sim.shot("list")
    for i in range(10):
        core.new_window(f"w{i:02d}")
    page = sim.expect(lambda p: listed(p) and total(p) == 14 and len(rows(p)) == 8, "a full window", 25)
    check(page["blocks"][0]["name"] == "rows0" and sim.cursor(page) == 0, "the window moved without the cursor")
    sim.shot("list-full")
    sim.move(12)
    page = sim.expect(lambda p: listed(p) and sim.cursor(p) == 13, "the cursor at the end")
    # Addresses sort as text, so work/10.0 and work/11.0 come before work/2.0 and w07 is last.
    check(page["blocks"][0]["name"] == "rows5" and rows(page)[-1].startswith("◌ bash · w07"), f"the window did not slide: {rows(page)}")
    sim.shot("list-end")
    sim.tap()
    sim.expect(lambda p: any("w07" in t for t in titles(p)), "the last pane opened")


@test("F11", "Open a pane, read its last lines, see a new line within the follow interval", "UI")
def f11(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    check(any(l.startswith("$") for l in sim.lines()), f"no prompt on screen: {sim.lines()}")
    n = len(proxy.paths("/v1/panes/"))
    wait_for("three more reads", lambda: len(proxy.paths("/v1/panes/")) >= n + 3, 10)
    core.keys("echo hello", "Enter")
    t0 = time.time()
    sim.expect(lambda p: any(l == "hello" for l in (sim.block("body", p) or [])), "hello on the glasses", 6)
    sim.shot("pane-hello")
    reads = proxy.paths("/v1/panes/")
    check(any(r["headers"].get("If-None-Match") for r in reads), "no If-None-Match on a follow-up read")
    check(time.time() - t0 < 6, "the new line took too long")


@test("F12", "Scroll up pages back and pauses following; down past the end follows again", "UI")
def f12(run, name):
    core, proxy, sim, tok = setup(run, name)
    core.keys("seq 1 40", "Enter")
    open_pane(sim)
    sim.expect(lambda p: any(l == "40" for l in (sim.block("body", p) or [])), "the sequence")
    check(not any(c["w"] < 16 or c["h"] < 16 for c in sim.last()["charts"]), "a picture too thin for the glasses")
    sim.shot("bottom")
    sim.scroll("up")
    page = sim.head("paused · 1 page up", "one page up")
    check("40" not in (sim.block("body", page) or []), "the view did not move")
    sim.shot("one-up")
    sim.scroll("up")
    sim.head("paused · 2 pages up", "two pages up")
    n = len(proxy.paths("/v1/panes/"))
    time.sleep(3)
    check(len(proxy.paths("/v1/panes/")) == n, "the pane was read while paused")
    sim.scroll("down")
    sim.scroll("down")
    page = sim.expect(lambda p: any(b.get("name") == "state" and b["lines"][0] == "work/0.0" for b in p["blocks"]), "following again")
    check("40" in (sim.block("body", page) or []), "the bottom did not come back")
    sim.shot("bottom-again")


@test("F13", "Answers: y confirmed reaches the pane, Cancel sends nothing, Ctrl-C stops a command", "UI")
def f13(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][1] == "y, Enter", page["items"])
    sim.shot("answers")
    sim.choose(1)
    page = sim.head("send y, Enter to test-pane?", "the confirmation")
    check(page["items"] == ["Cancel", "Confirm"], page["items"])
    sim.shot("confirm")
    sim.choose(1)
    sim.head("sent y, Enter", "the flash", 10)
    wait_for("y typed", lambda: "y: command not found" in core.pane(), 5)
    sim.expect(lambda p: any("y: command not found" in l for l in (sim.block("body", p) or [])), "the pane after", 8)
    sim.shot("pane-after")
    posts = [r for r in proxy.requests if r["method"] == "POST"]
    check([json.loads(r["body"]) for r in posts] == [{"text": "y"}, {"key": "Enter"}], f"posts: {[r['body'] for r in posts]}")
    sim.tap()
    sim.head("answer test-pane", "the answers again")
    sim.choose(0)
    sim.head("send Enter to test-pane?", "the confirmation")
    sim.choose(0)
    wait_for("back on the pane", lambda: sim.last()["kind"] == "dash" and sim.block("body") is not None, 10)
    time.sleep(1)
    check(len([r for r in proxy.requests if r["method"] == "POST"]) == 2, "Cancel sent something")
    core.keys("sleep 100", "Enter")
    wait_for("sleep running", lambda: core.command() == "sleep", 5)
    sim.tap()
    sim.head("answer test-pane", "the answers")
    sim.choose(7)
    sim.head("send Ctrl-C to test-pane?", "the confirmation")
    sim.choose(1)
    wait_for("sleep stopped", lambda: core.command() == "bash", 5)
    sim.head("sent Ctrl-C", "the flash", 10)
    sim.shot("after-ctrl-c")


@test("F14", "The Claude Code lens: chrome hidden, the suggestion not drawn but offered first and sent, reveal all", "UI")
def f14(run, name):
    core, proxy, sim, tok = setup(run, name, mode="claude", says_claude=True)
    home(sim)
    sim.pick(0)
    page = sim.expect(lambda p: (sim.block("body", p) or [""])[-1] == "* pong", "the lens", 15)
    body = sim.block("body", page)
    check(len(body) == 8, f"{len(body)} lines")
    check(not any("fix the typo" in l for l in body), "the suggestion is on the pane")
    check(not any("auto mode" in l or "Crunched" in l for l in body), "chrome in the body")
    check(any("Claude" in t for t in titles(page)), f"the title does not name the program: {titles(page)}")
    check(page["charts"] == [], "a picture on the pane")
    sim.shot("lens")
    sim.menu(0)
    sim.expect(lambda p: any("auto mode" in l for l in (sim.block("body", p) or [])), "reveal all", 10)
    sim.shot("lens-reveal")
    sim.menu(0)
    sim.expect(lambda p: not any("auto mode" in l for l in (sim.block("body", p) or ["auto mode"])), "the lens again", 10)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][:2] == ['» "fix the typo in README"', "Enter"], page["items"][:3])
    sim.shot("answers-offer")
    sim.choose(0)
    page = sim.head("send this to test-pane?", "the confirmation")
    check(sim.block("text", page) == ["fix the typo in README"], f"the confirmation's box: {sim.block('text', page)}")
    sim.shot("offer-confirm")
    sim.tap()
    sim.head('sent "fix the typo in README"', "the flash", 10)
    wait_for("typed", lambda: "fix the typo in README" in core.pane(), 5)
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/input")]
    check(posts == [{"text": "fix the typo in README"}, {"key": "Enter"}], str(posts))
    sim.shot("offer-sent")


@test("F15", "A notification: a banner within two seconds, the pane first in the list with its word, cleared by working", "UI")
def f15(run, name):
    core, proxy, sim, tok = setup(run, name, before=lambda c: c.new_window("build"))
    open_pane(sim)
    t0 = time.time()
    core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
    page = sim.expect(lambda p: p.get("hintBorder") and p["hintLevel"] == 4, "the banner", 8)
    check(time.time() - t0 < 4, f"the banner took {time.time() - t0:.1f} s")
    check(page["hint"] == "★ build: Claude needs your permission to use Bash", page["hint"])
    check(any(m["label"] == "Go to: build" for m in page["menu"]), page["menu"])
    sim.shot("banner")
    sim.back()
    page = sim.expect(lambda p: listed(p) and len(rows(p)) > 1 and rows(p)[1].startswith("★ bash · build"), "build first among the panes")
    check(rows(page)[0] == "◆ inbox · 1 waiting", rows(page)[0])
    check(rows(page)[1] == "★ bash · build · needs permission", rows(page)[1])
    sim.shot("list-attention")  # the toast still holds the hint here; the count in it is F41's
    core.notify("working", "", "work:build.0")
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("★") or i.startswith("◆") for i in rows(p)), "cleared", 8)
    check(any(i[2:].startswith("bash · build · ") and i[0] in "◌◐◑" and ("working" in i or "active" in i or "quiet" in i) for i in rows(page)), rows(page))
    check(not page["hint"].startswith("◆"), page["hint"])
    sim.shot("list-cleared")


@test("F17", "Hub down and host offline: said on the pane, recovered when back", "UI")
def f17(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    core.stop("agent")
    sim.head("host offline", "host offline", 15)
    sim.shot("host-offline")
    core.start_agent()
    wait_for("following again", lambda: following(sim), 15)
    core.stop("hub")
    sim.expect(lambda p: "hub unreachable" in words(p) or "no connection" in words(p), "hub down", 15)
    sim.shot("hub-down")
    core.start_hub()
    core.start_agent()
    wait_for("recovered", lambda: following(sim), 40)
    sim.shot("recovered")


@test("F30", "Loading: the reading row and the dots until the first listing; then the list; the double tap asks to leave", "UI")
def f30(run, name):
    core, proxy, sim, tok = setup(run, name, mode="slow-list", before=lambda c: c.new_window("build"))
    page = sim.expect(lambda p: p["kind"] == "dash" and rows(p) == ["reading the hub…"], "the loading row", 10)
    check(page["hint"].startswith("reading the hub ·"), page["hint"])
    check("head" not in page, "a head on the page")
    sim.shot("loading")
    hints = set()
    end = time.time() + 2
    while time.time() < end:
        hints.update(p["hint"] for p in sim.trace() if p["hint"].startswith("reading the hub"))
        time.sleep(0.2)
    check(len(hints) >= 2, f"the dots did not move: {hints}")
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "the list", 20)
    check(page["blocks"][0]["y"] == 0, "the list does not start at the top")
    check(page["hint"] == "▽ move · ● open · hold to select · ×× exit", page["hint"])
    check(page["blocks"][0]["lines"][0].startswith("> "), "no cursor mark on the first row")
    check(page["menu"] == [], "the list has a menu, so a hold would open it")
    sim.shot("list")
    sim.back()
    time.sleep(1.5)
    check(not any("uncaught" in e["message"] for e in sim.console()), "an uncaught error on leaving")


@test("F31", "Two panes waiting, one done and one quiet: the inbox row, then the panes with their words; the inbox page oldest first, a row opens its pane", "UI")
def f31(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("logs")
        core.new_window("tests")
        core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
        time.sleep(1.1)  # the inbox orders by the second
        core.notify("question", "Which file?", "work:0.0")
        time.sleep(1.1)
        core.notify("done", "", "work:tests.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 5 and rows(p)[2].startswith("★"), "five rows", 20)
    check(rows(page)[0] == "◆ inbox · 3 waiting", rows(page))
    check(rows(page)[1] == "★ bash · test-pane · asks a question", rows(page))
    check(rows(page)[2] == "★ bash · build · needs permission", rows(page))
    check(rows(page)[3] == "√ bash · tests · done", rows(page))
    check(rows(page)[4] in ("◌ bash · logs · quiet", "◌ bash · logs · quiet"), rows(page))
    sim.shot("list-attention")
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "dash" and p["hint"].startswith("inbox · 3 waiting"), "the inbox page", 10)
    items = inbox_rows(page)
    check([i.rsplit(" · ", 1)[0] for i in items] == ["★ bash · build · needs permission", "★ bash · test-pane · asks a question", "√ bash · tests · done"], items)
    check(all(re.search(r" · \d+s$", i) for i in items), f"no age on a row: {items}")
    # The notice's text under the row.
    check(allrows(page)[1] == "    Claude needs your permission to use Bash" and allrows(page)[3] == "    Which file?", allrows(page))
    check(any(r["path"] == "/v1/inbox" for r in proxy.requests), "the inbox was not read from the hub")
    sim.shot("inbox")
    inbox_pick(sim, 1)
    wait_for("the second pane", lambda: sim.block("state") is not None, 10)
    check(sim.state() == "asks a question", sim.state())
    check(any("test-pane" in t for t in titles(sim.last())), titles(sim.last()))
    sim.shot("inbox-pane")
    sim.back()
    sim.expect(lambda p: p["kind"] == "dash" and p["hint"].startswith("inbox · "), "back on the inbox", 10)
    sim.back()
    home(sim)


@test("F40", "A question with choices: the toast, the row, the choices first on the answers page, confirmed, answered through /answer and nothing typed; muxway ask exits 0 with it", "UI")
def f40(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    ask = core.ask("deploy to staging?", ["yes", "no", "later"])
    run.cleanups.append(ask.kill)
    page = sim.expect(lambda p: p.get("hintBorder") and p["hintLevel"] == 4, "the toast", 8)
    check(page["hint"] == "★ test-pane: deploy to staging?", page["hint"])
    sim.shot("toast")
    wait_for("the state", lambda: "asks a question" in sim.state(), 10)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][:4] == ["» yes", "» no", "» later", "Enter"], page["items"][:5])
    sim.shot("answers-choices")
    sim.choose(1)
    page = sim.head("answer no to test-pane?", "the confirmation")
    check(page["items"] == ["Cancel", "Confirm"], page["items"])
    sim.shot("confirm")
    sim.choose(1)
    sim.head("answered no", "the flash", 10)
    check(ask.wait(10) == 0, f"muxway ask exited {ask.returncode}")
    check(ask.stdout.read().strip() == "no", "the ask did not print the choice")
    posts = [json.loads(r["body"]) for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/answer")]
    check(posts == [{"choice": "no"}], str(posts))
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "something was typed into the pane")
    wait_for("the state cleared", lambda: following(sim), 10)
    sim.shot("answered")
    sim.back()
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("◆") for i in rows(p)), "nothing waits", 10)


@test("F41", "The inbox from the list: two waiting on two windows, the oldest first; Go to takes the oldest", "UI")
def f41(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
        core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
        time.sleep(1.1)
        core.notify("question", "Which file?", "work:tests.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 4, "the list", 20)
    check(rows(page)[0] == "◆ inbox · 2 waiting", rows(page))
    check(page["hint"].startswith("◆ 2 · "), page["hint"])
    sim.shot("inbox-row")
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "dash" and p["hint"].startswith("inbox · 2 waiting"), "the inbox page", 10)
    check([i.rsplit(" · ", 1)[0] for i in inbox_rows(page)] == ["★ bash · build · needs permission", "★ bash · tests · asks a question"], inbox_rows(page))
    sim.shot("inbox")
    sim.back()
    home(sim)
    # The quiet pane: its menu's Go to names the pane that has waited longest.
    sim.pick(3)
    sim.expect(lambda p: any(b.get("name") == "title" and "test-pane" in b["lines"][0] for b in p["blocks"]), "test-pane")
    wait_for("following", lambda: following(sim), 10)
    page = sim.last()
    check(any(m["label"] == "Go to: build" for m in page["menu"]), page["menu"])
    sim.shot("go-to-oldest")


@test("F42", "A Codex pane is named Codex in the list and on the pane; working from its event", "UI")
def f42(run, name):
    core, proxy, sim, tok = setup(run, name, says="codex")
    # A harness works while its screen moves, ten seconds; the shell started as the test did, so first the quiet.
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "◌ Codex · test-pane · quiet", "quiet before the event", 40)
    core.notify("working", "", "work:0.0")
    page = sim.expect(lambda p: listed(p) and rows(p)[0] in ("◐ Codex · test-pane · working", "◑ Codex · test-pane · working"), "working", 8)
    sim.shot("list-codex")
    # A working row is plain: the same strength as the quiet one before the event. Its mark turns within a second.
    check(next(b["level"] for b in page["blocks"] if b.get("name", "").startswith("rows")) == 3, page["blocks"])
    other = "◑" if rows(page)[0][0] == "◐" else "◐"
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == f"{other} Codex · test-pane · working", "the mark's other half", 3)
    sim.shot("list-codex-turned")
    sim.pick(0)
    page = sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] in ("◐ Codex · test-pane", "◑ Codex · test-pane") for b in p["blocks"]), "the pane names Codex", 10)
    check(next(b["level"] for b in page["blocks"] if b.get("name") == "title") == 4, page["blocks"])
    sim.shot("pane-codex")


@test("F43", "A named pane goes by its name, the program and its title after it; the folder after the name for a writer under a preview root, left out when the row has no room", "UI")
def f43(run, name):
    def before(core):
        core.new_window("notes", title="notes.md", cwd=core.preview / "src", alias="notes")
    core, proxy, sim, tok = setup(run, name, preview=True, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "two rows", 20)
    check(rows(page) == ["◌ bash · test-pane · quiet", "◌ notes · /src · bash · notes.md · quiet"], rows(page))
    sim.shot("list-named")
    long = "a title of sixty characters that leaves the row no room at all"
    core.tmux_cmd("select-pane", "-t", "work:notes.0", "-T", long)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and rows(p)[1].startswith("◌ notes · bash · a title"), "the long title", 20)
    check("/src" not in rows(page)[1], rows(page))
    sim.shot("list-long")
    core.tmux_cmd("select-pane", "-t", "work:notes.0", "-T", "notes.md")
    # Pages before this point already had the folder; the wait is for a newer one.
    sim.mark = len(sim.trace())
    sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and rows(p)[1] == "◌ notes · /src · bash · notes.md · quiet", "the folder back", 20)
    sim.pick(1)
    sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] == "◌ notes · /src · bash · notes.md" for b in p["blocks"]), "the title with the folder", 10)
    wait_for("following", lambda: following(sim), 10)
    sim.shot("pane-named")


@test("F44", "Later from the pane's menu: the row last with zz and the word, a new kind underneath without a toast, Go to gone, the inbox lists it; opening it wakes it and the row is back; Wake and Later toggle from the menu", "UI")
def f44(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
        core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 4, "the list", 20)
    check(rows(page)[:2] == ["◆ inbox · 1 waiting", "★ bash · build · needs permission"], rows(page))
    title = lambda text: (lambda p: any(b.get("name") == "title" and b["lines"][0] == text for b in p["blocks"]))
    menu = lambda: [m["label"] for m in sim.last()["menu"]]

    def pick_menu(label):
        labels = menu()
        check(label in labels, labels)
        sim.menu(labels.index(label))

    sim.pick(1)
    sim.expect(title("★ bash · build"), "the pane", 10)
    wait_for("needs permission", lambda: sim.state() == "needs permission", 10)
    pick_menu("Later")
    wait_for("the flash", lambda: sim.state() == "parked", 10)
    sim.expect(title("zz bash · build"), "the parked title", 10)
    wait_for("the parked state", lambda: sim.state() == "later · permission", 10)
    check("Wake" in menu() and not any(l.startswith("Go to") for l in menu()), menu())
    sim.shot("pane-parked")
    # A new kind on the parked pane: the words change, no toast.
    seen = len(sim.trace())
    core.notify("question", "Which file?", "work:build.0")
    wait_for("the question underneath", lambda: sim.state() == "later · question", 10)
    check(not any(p.get("hintBorder") for p in sim.trace()[seen:]), "a toast for a parked pane")
    sim.back()
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 4 and rows(p)[3].startswith("zz"), "build last", 10)
    check(rows(page)[0] == "◆ inbox · 1 waiting" and rows(page)[3] == "zz bash · build · later · asks a question", rows(page))
    check(rows(page)[1].startswith("◌ bash · test-pane · ") and rows(page)[2].startswith("◌ bash · tests · "), rows(page))
    check(page["hint"].startswith("◆ 1 · "), page["hint"])
    sim.shot("list-parked")
    # Another pane's menu: no Go to, since only the parked pane waits.
    sim.pick(1)
    sim.expect(title("◌ bash · test-pane"), "test-pane", 10)
    wait_for("following", lambda: following(sim), 10)
    check(not any(l.startswith("Go to") for l in menu()), menu())
    sim.back()
    home(sim)
    sim.pick(0)
    page = sim.expect(lambda p: p["kind"] == "dash" and p["hint"].startswith("inbox · 1 waiting"), "the inbox page", 10)
    check(re.fullmatch(r"zz bash · build · later · asks a question · \d+s", allrows(page)[0]), allrows(page))
    sim.shot("inbox-parked")
    sim.back()
    home(sim)
    # Opening the parked pane from the list wakes it.
    sim.pick(3)
    sim.expect(title("★ bash · build"), "the woken pane", 10)
    wait_for("asks a question", lambda: sim.state() == "asks a question", 10)
    laters = [r for r in proxy.requests if r["method"] == "POST" and r["path"].endswith("/later")]
    check([json.loads(r["body"]) for r in laters] == [{"later": True}, {"later": False}], [(r["path"], r["body"]) for r in laters])
    sim.back()
    page = sim.expect(lambda p: listed(p) and rows(p)[1].startswith("★ bash · build"), "build back in its place", 10)
    check(rows(page)[0] == "◆ inbox · 1 waiting" and rows(page)[1] == "★ bash · build · asks a question" and len(rows(page)) == 4, rows(page))
    sim.shot("list-woken")
    # Later and Wake toggle from the pane's menu.
    sim.pick(1)
    sim.expect(title("★ bash · build"), "the pane again", 10)
    wait_for("asks a question", lambda: sim.state() == "asks a question", 10)
    pick_menu("Later")
    wait_for("the parked state", lambda: sim.state() == "later · question", 15)
    pick_menu("Wake")
    wait_for("the flash", lambda: sim.state() == "woken", 10)
    wait_for("awake", lambda: sim.state() == "asks a question", 15)
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "something was typed into the pane")
    sim.shot("pane-woken")


@test("F50", "A write and a mail from one pane to another, each naming its origin: the two rows kept together behind the bar, mail 1 after the name, the third pane without a bar, the title the same, no toast", "UI")
def f50(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "three rows", 20)
    check(rows(page) == ["◌ bash · test-pane · quiet", "◌ bash · build · quiet", "◌ bash · tests · quiet"], rows(page))
    sim.shot("list-before")
    origin = f"{HOST}/{core.pane_id('work:0.0')}"
    core.client(tok, "send", f"{HOST}/work/tests.0", "echo hi", "--from", origin)
    core.client(tok, "mail", f"{HOST}/work/tests.0", "run the tests and tell me", "--from", origin)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 4 and rows(p)[2].startswith("│ ◌ bash · tests · mail 1 · "), "the group and the mail", 15)
    check(rows(page)[0] == "» messages · mail 2", rows(page))
    check(rows(page)[1].startswith("│ ◌ bash · test-pane · "), rows(page))
    check(rows(page)[3].startswith("◌ bash · build · "), rows(page))
    check("mail" not in page["hint"] and not page.get("hintBorder"), page["hint"])
    sim.shot("talk-list")
    sim.pick(2)
    sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] == "│ ◌ bash · tests · mail 1" for b in p["blocks"]), "the title with the bar and the mail", 10)
    wait_for("following", lambda: following(sim), 10)
    sim.shot("talk-pane")
    check(not any(r["method"] == "POST" and r["path"].endswith("/mail") for r in proxy.requests), "the app mailed")


@test("F32", "Hold starts selection mode with the row selected, taps select more, the open row appears, both columns follow; three at most; clear", "UI")
def f32(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("logs")
        core.new_window("more")
        core.keys("echo left-side", "Enter")
        core.keys("echo right-side", "Enter", target="work:build.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = home(sim)
    check(rows(page) == ["◌ bash · test-pane · quiet", "◌ bash · build · quiet", "◌ bash · logs · quiet", "◌ bash · more · quiet"], rows(page))
    sim.hold(0)
    page = sim.expect(lambda p: listed(p) and rows(p)[0].startswith("[x] ◌ bash · test-pane"), "selection mode, test-pane selected")
    check(rows(page)[1:] == ["[ ] ◌ bash · build · quiet", "[ ] ◌ bash · logs · quiet", "[ ] ◌ bash · more · quiet", "→ clear selection"], rows(page))
    check(page["hint"].startswith("▽ move · ● select · 3 at most"), page["hint"])
    sim.pick(1)
    page = sim.expect(lambda p: listed(p) and rows(p)[1].startswith("[x] ◌ bash · build"), "build selected by a tap")
    check(rows(page)[4:] == ["→ open 2 side by side", "→ clear selection"], rows(page))
    sim.shot("list-selected")
    sim.pick(4)
    page = sim.expect(lambda p: p["kind"] == "dash" and col(p, 1) is not None, "the columns")
    check(len(titles(page)) == 2 and "test-pane" in titles(page)[0] and "build" in titles(page)[1], titles(page))
    check(not any(t.startswith("»") for t in titles(page)), "a column marked before any scroll")
    check(page["charts"] == [], "a picture on the columns")
    page = sim.expect(lambda p: any("left-side" in l for l in (col(p, 0) or {"lines": []})["lines"]) and any("right-side" in l for l in (col(p, 1) or {"lines": []})["lines"]), "both columns read", 15)
    sim.shot("split")
    core.keys("echo later", "Enter")
    sim.expect(lambda p: any("later" in l for l in (col(p, 0) or {"lines": []})["lines"]), "the left column follows", 8)
    sim.back()
    page = sim.expect(lambda p: listed(p) and rows(p)[0].startswith("[x] ") and rows(p)[1].startswith("[x] "), "the list, still selecting, selection kept")
    sim.pick(2)
    page = sim.expect(lambda p: listed(p) and rows(p)[2].startswith("[x] ◌ bash · logs"), "logs selected")
    check(rows(page)[4] == "→ open 3 side by side", rows(page))
    sim.pick(3)
    page = sim.expect(lambda p: p.get("hintBorder") and p["hint"].startswith("3 panes at most"), "the limit said", 5)
    check(rows(page)[3].startswith("[ ] "), rows(page)[3])
    sim.shot("list-three")
    sim.pick(4)
    page = sim.expect(lambda p: p["kind"] == "dash" and col(p, 2) is not None, "three columns", 10)
    check(len(titles(page)) == 3, titles(page))
    sim.shot("split-three")
    sim.back()
    home(sim)
    sim.pick(5)
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("[") or i.startswith("→") for i in rows(p)), "cleared and out of selection mode")
    check(page["hint"].startswith("▽ move · ● open"), page["hint"])
    sim.shot("list-cleared")
    sim.hold(1)
    sim.expect(lambda p: listed(p) and rows(p)[1].startswith("[x] "), "selecting again")
    sim.back()
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("[") for i in rows(p)), "a double tap leaves selection mode")


@test("F33", "In the columns a scroll marks a pane without opening it; tap opens the marked, which pages and answers; back returns with it marked; back reaches the list", "UI")
def f33(run, name):
    def before(core):
        core.new_window("build")
        core.keys("seq 1 40", "Enter", target="work:build.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = to_split(sim)
    check(page["hint"].startswith("▽ pick a pane · ● refresh"), page["hint"])
    sim.scroll("down")
    page = sim.expect(lambda p: col(p, 1) is not None and titles(p)[0].startswith("» "), "the first column marked", 10)
    check("test-pane" in titles(page)[0] and not titles(page)[1].startswith("» "), titles(page))
    check(page["hint"].startswith("▽ next pane · ● open test-pane"), page["hint"])
    sim.shot("split-marked")
    sim.scroll("down")
    page = sim.expect(lambda p: col(p, 1) is not None and titles(p)[1].startswith("» ") and not titles(p)[0].startswith("» "), "the second column marked", 10)
    sim.shot("split-second")
    sim.scroll("down")
    time.sleep(1)
    page = sim.last()
    check(col(page, 1) is not None and titles(page)[1].startswith("» "), "a scroll past the last column moved the mark or opened something")
    sim.tap()
    sim.expect(lambda p: sim.block("state", p) is not None and any("build" in t for t in titles(p)), "build full", 10)
    wait_for("the sequence", lambda: "40" in (sim.block("body") or []), 10)
    sim.scroll("up")
    sim.head("paused · 1 page up", "paged")
    sim.shot("split-open")
    sim.tap()
    sim.head("answer build", "the answers of the open pane")
    sim.back()
    sim.expect(lambda p: sim.block("state", p) is not None and any("build" in t for t in titles(p)), "back on build", 10)
    sim.back()
    page = sim.expect(lambda p: col(p, 1) is not None and titles(p)[1].startswith("» "), "back on the columns, build marked")
    sim.shot("split-back")
    sim.back()
    sim.expect(lambda p: listed(p) and rows(p)[0].startswith("[x] ") and rows(p)[1].startswith("[x] "), "the list, selection kept")
    sim.shot("list-after")


@test("F35", "Listening: the graph grows with the tone and the seconds count; heard this in its box", "UI")
def f35(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True)
    open_pane(sim)
    say_it(sim)
    time.sleep(1)
    k0 = [c["key"] for c in sim.last()["charts"] if c["key"].startswith("levels:")]
    n0 = sim.block("note")[0]
    time.sleep(3)
    page = sim.last()
    k1 = [c["key"] for c in page["charts"] if c["key"].startswith("levels:")]
    check(k0 and k1 and k0 != k1, f"the graph did not take new frames: {k0} -> {k1}")
    check(sim.block("note", page)[0] != n0 and "of 60 s" in sim.block("note", page)[0], "the seconds did not count")
    check(not any(c["w"] < 16 or c["h"] < 16 for c in page["charts"]), "a picture too thin for the glasses")
    check(any(c["key"].startswith("levels:") for c in page["charts"]), "no graph")
    sim.shot("listening-graph")
    sim.tap()
    page = sim.head("heard this", "the transcript", 15)
    check(any(b.get("name") == "text" and b.get("border") for b in page["blocks"]), "the transcript has no box")
    check(any("heard this" in t for t in titles(page)), titles(page))
    sim.shot("heard-box")


# --- the phone pane, in Chromium -------------------------------------------------------

@test("F16", "Phone pane: settings saved and tested, URL rules, reply without the glasses", "UI")
def f16(run, name):
    core, proxy = None, None
    logs = run.logs(name)
    core = Core(run, run.binary, logs).start()
    run.cleanups.append(core.close)
    tok = core.token()
    proxy = Proxy(core.url, logs)
    run.cleanups.append(proxy.close)
    out = run.out / "traces"
    out.mkdir(exist_ok=True)
    env = {**os.environ, "APP_URL": run.static.url, "HUB_URL": proxy.url, "TOKEN": tok, "SHOTS": str(run.screens(name)),
           "TRACE": str(out / f"{name}.zip")}
    r = subprocess.run(["node", str(harness.ROOT / "tests" / "e2e" / "phone.mjs")], capture_output=True, text=True,
                       timeout=180, env=env, cwd=str(harness.ROOT))
    (logs / "playwright.log").write_text(r.stdout + r.stderr)
    for p in sorted(run.screens(name).glob("*.png")):
        run.add_shot(name, p)
    check(r.returncode == 0, f"phone tests failed:\n{(r.stdout + r.stderr)[-3000:]}")
    me = [x for x in proxy.requests if x["path"] == "/v1/me"]
    check(me and me[-1]["headers"].get("Authorization") == "Bearer " + tok, "the phone pane did not test the token")
    check(not any(tok in x["path"] for x in proxy.requests), "the token appeared in a URL")



@test("F70", "The trace switch on the glasses' build: a tap on a row and back, the phone pane's log with the draws, their sizes and times", "UI")
def f70(run, name):
    core, proxy, sim, tok = setup(run, name, params={"detail": "1"})
    sim.expect(lambda p: listed(p) and len(rows(p)) == 1, "the list", 20)
    sim.pick(0)
    sim.expect(titled("test-pane"), "the pane", 10)
    sim.web("phone-trace-pane")
    sim.back()
    sim.expect(listed, "the list again", 10)
    sim.web("phone-trace-list")
    # The phone pane is read by its screenshot alone here: the simulator's automation reads the console and the
    # glasses, not the WebView's page. The lines themselves are the unit test's; nothing of the token in any log.
    check(not any(tok in e["message"] for e in sim.console()), "the token in the console")


# --- the parity pass of 2026-11-04: messages, mail, the list and the pane page ----------------

def menu_labels(sim):
    return [m["label"] for m in sim.last()["menu"]]


def pick_menu(sim, label, wait=1.5):
    labels = menu_labels(sim)
    check(label in labels, f"no {label!r} in {labels}")
    sim.menu(labels.index(label), wait)


def has_title(text):
    return lambda p: any(b.get("name") == "title" and b["lines"][0] == text for b in p["blocks"])


def titled(text):
    return lambda p: any(b.get("name") == "title" and text in b["lines"][0] for b in p["blocks"])


def posts(proxy, suffix):
    """The app's POSTs with the path's suffix: the page's requests carry an Origin, a direct one does not."""
    return [(r["path"], json.loads(r["body"]) if r["body"] else {}) for r in proxy.requests
            if r["method"] == "POST" and r["path"].endswith(suffix) and r["headers"].get("Origin") is not None]


def origin(core, target="work:0.0"):
    return f"{HOST}/{core.pane_id(target)}"


def no_typing(proxy):
    check(not any(r["method"] == "POST" and r["path"].endswith("/input") for r in proxy.requests), "something was typed into a pane")


@test("S60", "A read-only token: no Later, Close or + pane in the menu, no mail back, no commands; the feed and the mailbox read; mail, close, split and a session refused directly and from the glasses", "e2e-security")
def s60(run, name):
    def before(core):
        core.new_window("review", alias="review")
        writer = core.token(name="writer")
        core.client(writer, "mail", f"{HOST}/work/0.0", "run the tests and tell me", "--from", origin(core, "work:review.0"))
    core, proxy, sim, tok = setup(run, name, write=None, sessions=True, close=True, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "the list", 20)
    check(rows(page)[0] == "» messages", rows(page))
    check(allrows(page)[1] == f"── {HOST} · online · + session ──", allrows(page))
    sim.pick(1)
    sim.expect(titled("test-pane · mail 1"), "the pane", 10)
    wait_for("read-only", lambda: sim.state().startswith("read-only"), 10)
    labels = menu_labels(sim)
    check(not any(l in ("Later", "Wake", "Close pane", "+ pane") for l in labels), labels)
    check("Mail" in labels, labels)
    sim.shot("menu-reader")
    pick_menu(sim, "Mail")
    page = sim.head("mail · test-pane · 1 unread", "the mail page", 10)
    check("mail back" not in page["hint"], page["hint"])
    check(allrows(page)[0].startswith("← review · ") and allrows(page)[1] == "    run the tests and tell me", allrows(page))
    check(page["menu"] and not any(l.startswith("Mail ") for l in menu_labels(sim)), menu_labels(sim))
    sim.tap()
    time.sleep(1)
    sim.shot("mail-reader")
    sim.back()
    sim.back()
    # The host's line offers a session to everyone; the hub refuses a reader.
    page = home(sim)
    sim.move(1, every=True)
    sim.tap()
    page = sim.head("a session on", "the name page", 10)
    check(page["items"][0] == "» glasses-1", page["items"])
    sim.choose(0)
    sim.head("start session glasses-1 on", "the confirmation", 10)
    sim.choose(1)
    sim.head("read only", "the refusal", 10)
    sim.shot("session-refused")
    for path, body in ((f"/v1/panes/{HOST}/work/0.0/mail", '{"text":"hi"}'), (f"/v1/panes/{HOST}/work/0.0/close", "{}"),
                       (f"/v1/windows/{HOST}/work/0/panes", '{"direction":"h"}'), (f"/v1/hosts/{HOST}/sessions", '{"name":"x"}')):
        time.sleep(2.5)  # one creation or close per two seconds per principal, refused or not
        status, out = direct(proxy.url, tok, "POST", path, body)
        check(status == 403, f"{path} with a reader got {status} {out[:80]!r}")
    check(not posts(proxy, "/mail") and not posts(proxy, "/close") and not posts(proxy, "/panes") and len(posts(proxy, "/sessions")) == 1, "the glasses wrote")
    no_typing(proxy)
    check(core.tmux_cmd("list-windows") .count("\n") == 1, "a window came or went")


@test("S61", "Hostile feed and mailbox from the proxy: entries of 50 KiB, a destination that is no address, a seq that is a string, junk replies, an actor of 300 characters, forty mails with control bytes and one of 30 KiB: the bad dropped, the rest cut and wrapped, both pages accepted, nothing sent", "e2e-security")
def s61(run, name):
    core, proxy, sim, tok = setup(run, name, mode="feed-hostile", before=lambda c: c.new_window("build"))
    page = sim.expect(lambda p: listed(p) and rows(p)[0].startswith("» messages"), "the messages row", 20)
    sim.tap()
    page = sim.head("messages · 97 ·", "the messages page", 10)
    items = allrows(page)
    check(len(items) == 9 and all(len(r.encode()) <= 80 for r in items), [len(r.encode()) for r in items])
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(page)), "control characters reached the page")
    check(any(r.startswith("test-pane → build · ") for r in items), items[:3])
    check(any(r.endswith("…") for r in items), "a long text was not cut")
    sim.shot("messages-hostile")
    sim.back()
    home(sim)
    sim.pick(1)
    sim.expect(titled("test-pane"), "the pane", 10)
    wait_for("following", lambda: following(sim), 10)
    pick_menu(sim, "Mail")
    page = sim.head("mail · test-pane · 21 unread", "the mail page", 10)
    items = allrows(page)
    # The page's rows are wrapped by pixels like the pane's body (the 63 bytes are the OS list's rule): nine of them, none wider than a row.
    check(len(items) == 9 and all(len(r.encode()) <= 80 for r in items), [len(r.encode()) for r in items])
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(page)), "control characters reached the page")
    sim.shot("mail-hostile")
    sim.tap()
    time.sleep(1)
    check(not posts(proxy, "/mail"), "the glasses mailed")
    no_typing(proxy)
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S62", "A proxy that calls a read-only pane writable and its host able: Close and + pane offered and refused in words, a session answered not found; a mail by voice offered and nothing sent without a transcriber", "e2e-security")
def s62(run, name):
    core, proxy, sim, tok = setup(run, name, write=None, mode="lie-able")
    open_pane(sim)
    pick_menu(sim, "Close pane")
    sim.head(f"end session work on {HOST}?", "the close confirmation", 10)
    sim.choose(1)
    sim.head("read only", "the refusal", 10)
    sim.shot("close-refused")
    pick_menu(sim, "+ pane")
    sim.head("one more pane beside test-pane?", "the split confirmation", 10)
    time.sleep(2.5)
    sim.choose(1)
    sim.head("read only", "the refusal", 10)
    pick_menu(sim, "Mail")
    sim.head("mail · test-pane", "the mail page", 10)
    pick_menu(sim, "Mail test-pane")
    sim.head("say it needs a transcriber", "no transcriber, no mail", 10)
    sim.shot("mail-no-transcriber")
    sim.back()
    sim.back()
    home(sim)
    sim.move(0, every=True)
    sim.tap()
    page = sim.head("a session on", "the name page", 10)
    check(page["items"] == ["» glasses-1"], page["items"])
    sim.choose(0)
    sim.head(f"start session glasses-1 on {HOST}?", "the confirmation", 10)
    time.sleep(2.5)
    sim.choose(1)
    # The host starts no sessions, whatever the proxy said: the hub's 404, in words.
    sim.head("not found", "the refusal", 10)
    sim.shot("session-refused")
    check([b for _, b in posts(proxy, "/sessions")] == [{"name": "glasses-1"}], posts(proxy, "/sessions"))
    check(len(posts(proxy, "/close")) == 1 and len(posts(proxy, "/panes")) == 1 and not posts(proxy, "/mail"), "the requests")
    no_typing(proxy)
    check(core.tmux_cmd("list-windows").count("\n") == 0 and core.tmux_cmd("list-panes").count("\n") == 0, "a pane came or went")


@test("S63", "Commands by the hub's command, never a title: a shell with a forged spark gets the shell's starters, python3 no row; a command sends its text and Enter, a key its name alone", "e2e-security")
def s63(run, name):
    def before(core):
        core.tmux_cmd("select-pane", "-t", "work:0.0", "-T", "✳ build")
        core.new_window("py")
        core.keys("python3 -q", "Enter", target="work:py.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and "python3" in rows(p)[1], "the python pane", 30)
    sim.pick(0)
    sim.expect(titled("build"), "the pane")
    wait_for("following", lambda: following(sim), 10)
    sim.tap()
    page = sim.head("answer build", "the answers")
    check(page["items"][-1] == "→ commands: the shell's", page["items"][-3:])
    sim.choose(len(page["items"]) - 1)
    page = sim.head("commands for build", "the commands", 10)
    check(len(page["items"]) == 20 and page["items"][0] == "exit" and not any(i.startswith("/") for i in page["items"]), page["items"][:3])
    sim.shot("commands-shell")
    sim.choose(8)
    sim.head("send git status to build?", "the confirmation", 10)
    sim.choose(1)
    sim.head("sent git status", "the flash", 10)
    wait_for("typed", lambda: "git status" in core.pane(), 5)
    check([b for _, b in posts(proxy, "/input")] == [{"text": "git status"}, {"key": "Enter"}], posts(proxy, "/input"))
    sim.tap()
    page = sim.head("answer build", "the answers again")
    sim.choose(len(page["items"]) - 2)
    page = sim.head("keys for build", "the keys", 10)
    check(page["items"] == ["Up", "Down", "Left", "Right", "PageUp", "PageDown", "Home", "End", "Tab", "Shift-Tab", "Enter", "Esc"], page["items"])
    sim.shot("keys")
    sim.choose(4)
    sim.head("send PageUp to build?", "the confirmation", 10)
    sim.choose(1)
    sim.head("sent PageUp", "the flash", 10)
    check([b for _, b in posts(proxy, "/input")][-1] == {"key": "PageUp"}, posts(proxy, "/input"))
    sim.back()
    home(sim)
    sim.pick(1)
    sim.expect(titled("python3"), "the python pane", 10)
    wait_for("following", lambda: following(sim), 10)
    sim.tap()
    page = sim.head("answer", "the answers of the python pane")
    check(page["items"][-1] == "→ keys" and not any(i.startswith("→ commands") for i in page["items"]), page["items"][-2:])
    sim.shot("answers-python")


@test("S64", "Fifty hostile recent events at start: working only from a working one that was last, bad kinds and addresses dropped, no toast", "e2e-security")
def s64(run, name):
    core, proxy, sim, tok = setup(run, name, mode="recent-hostile", says="codex", before=lambda c: c.new_window("build"))
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and rows(p)[1].endswith("· working"), "the list", 30)
    check(rows(page)[1] in ("◐ Codex · build · working", "◑ Codex · build · working"), rows(page))
    check(rows(page)[0] == "◌ Codex · test-pane · quiet" or rows(page)[0].startswith("◐ Codex · test-pane") or rows(page)[0].startswith("◑ Codex · test-pane"), rows(page))
    wait_for("test-pane quiet", lambda: rows(sim.last())[0] == "◌ Codex · test-pane · quiet", 30)
    check(not any(p.get("hintBorder") for p in sim.trace()), "a toast from the recent events")
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(sim.last())), "control characters reached the page")
    # The recent events were read once for the cursor, then the poll went on from it.
    recent = proxy.paths("/v1/events?limit=50")
    check(len(recent) <= 2, f"{len(recent)} reads of the recent events: the poll does not go on from the cursor")
    check(len(proxy.paths("/v1/events?after=49")) >= 1, "the poll did not go on from the cursor the recent events gave")
    sim.shot("recent-working")


@test("S65", "An oversized recent answer, over the 256 KiB cap: cut and unread, it sets nothing working and no toast, and the app asks again after the wait of a failed poll, never at once", "e2e-security")
def s65(run, name):
    core, proxy, sim, tok = setup(run, name, mode="recent-huge", says="codex", before=lambda c: c.new_window("build"))
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "the list", 30)
    # Nothing is working from an answer that could not be read; a fresh pane's own moving screen settles within ten seconds.
    wait_for("both panes quiet", lambda: all(r.endswith("quiet") or "· quiet " in r for r in rows(sim.last())), 30)
    time.sleep(6)
    recent = proxy.paths("/v1/events?limit=50")
    check(1 <= len(recent) <= 4, f"{len(recent)} reads of the recent events: the app spins on an answer it cannot read")
    check(not any(p.get("hintBorder") for p in sim.trace()), "a toast from the recent events")
    check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")
    sim.shot("recent-huge")


@test("F60", "Messages: a write and a mail between panes make the row with the count; the page oldest first with the newest in view, the mail entry; the count cleared; a tap on a typed entry lays the two side by side", "UI")
def f60(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "three rows", 20)
    core.client(tok, "send", f"{HOST}/work/tests.0", "echo hi", "--from", origin(core))
    time.sleep(1.1)
    core.client(tok, "mail", f"{HOST}/work/tests.0", "run the tests and tell me", "--from", origin(core, "work:build.0"))
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "» messages · mail 2", "the messages row", 20)
    check(not page.get("hintBorder"), page["hint"])
    sim.shot("messages-row")
    sim.tap()
    page = sim.head("messages · 2 · ▽ move · ● the mail · ×× back", "the messages page", 10)
    items = allrows(page)
    check(re.fullmatch(r"test-pane → tests · \d+s", items[0]) and items[1] == "    echo hi", items)
    check(re.fullmatch(r"build → tests · \d+s · mail", items[2]) and items[3] == "    run the tests and tell me", items)
    check(items[2].startswith("build") and page["blocks"][0]["lines"][2].startswith("> "), "the cursor is not on the newest")
    sim.shot("messages")
    sim.back()
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "» messages", "the count cleared", 10)
    sim.tap()
    sim.head("messages · 2", "the messages page again", 10)
    sim.scroll("up")
    page = sim.expect(lambda p: p["hint"].startswith("messages · 2 · ▽ move · ● side by side"), "the typed entry under the cursor", 10)
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "dash" and col(p, 1) is not None, "the columns", 10)
    check("test-pane" in titles(page)[0] and "tests" in titles(page)[1], titles(page))
    check(not any(t.startswith("» ") for t in titles(page)), titles(page))
    sim.shot("messages-columns")
    no_typing(proxy)


@test("F61", "The mail page: a received mail unread, a reply marks it replied, what went out from the feed; mail back by voice through Cancel / Confirm lands in the sender's mailbox and nothing is typed", "UI")
def f61(run, name):
    def before(core):
        core.new_window("review", alias="review")
    core, proxy, sim, tok = setup(run, name, stt=True, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "two rows", 20)
    core.client(tok, "mail", f"{HOST}/work/0.0", "run the tests and tell me", "--from", origin(core, "work:review.0"))
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "» messages · mail 1", "the mail arrived", 20)
    sim.pick(1)
    sim.expect(titled("test-pane · mail 1"), "the pane", 10)
    wait_for("following", lambda: following(sim), 10)
    pick_menu(sim, "Mail")
    page = sim.head("mail · test-pane · 1 unread · ● mail back · ≡ menu · ×× back", "the mail page", 10)
    items = allrows(page)
    check(re.fullmatch(r"← review · \d+s · unread", items[0]) and items[1] == "    run the tests and tell me", items)
    check(menu_labels(sim) == ["Mail test-pane", "Messages with test-pane"], menu_labels(sim))
    sim.shot("mail")
    # The process reads and answers it: replied, and the reply goes out.
    out = core.cli("mail", "--dir", str(core.dir / "agent"), "--pane", core.pane_id("work:0.0"))
    mail_id = re.search(r"^--- (\d+)", out, re.M).group(1)
    core.mail_reply(mail_id, "all green")
    page = sim.expect(lambda p: p["hint"].startswith("mail · test-pane · 0 unread") and len(allrows(p)) >= 4, "replied and the reply out", 20)
    items = allrows(page)
    check(re.fullmatch(r"← review · \d+s · replied", items[0]) and re.fullmatch(r"→ review · \d+s", items[2]) and items[3] == "    all green", items)
    sim.shot("mail-replied")
    # Mail back by voice: to the sender.
    sim.scroll("up")
    page = sim.expect(lambda p: "● mail back" in p["hint"], "the received mail under the cursor", 10)
    sim.tap()
    sim.head("listening", "listening", 10)
    time.sleep(1.5)
    sim.tap()
    page = sim.head("heard this", "the transcript", 15)
    check("for mail to review" in " ".join(sim.block("title", page) or []), sim.block("title", page))
    check("● mail" in page["hint"] and [m["label"] for m in page["menu"]] == ["Say it again"], (page["hint"], page["menu"]))
    sim.shot("mail-heard")
    sim.tap()
    page = sim.head("mail this to review?", "the confirmation", 10)
    check(page["items"] == ["Cancel", "Confirm"], page["items"])
    sim.shot("mail-confirm")
    sim.choose(1)
    sim.head("mailed review", "the words", 10)
    sim.shot("mail-sent")
    check([b for _, b in posts(proxy, "/mail")] == [{"text": "run the tests again"}], posts(proxy, "/mail"))
    check(posts(proxy, "/mail")[0][0] == f"/v1/panes/{HOST}/work/1.0/mail", posts(proxy, "/mail"))
    no_typing(proxy)
    check("run the tests again" not in core.pane() and "run the tests again" not in core.pane("work:review.0"), "the mail was typed")
    sim.back()
    sim.back()
    page = sim.expect(lambda p: listed(p) and any(r.startswith("│ ◌ review · mail 2 · ") for r in rows(p)), "the sender holds the reply and the mail back", 20)
    sim.shot("mail-list")


@test("F62", "Beside from the pane menu: the columns with the pane and its partner, nothing marked; back returns to the pane", "UI")
def f62(run, name):
    core, proxy, sim, tok = setup(run, name, before=lambda c: c.new_window("build"))
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "two rows", 20)
    core.client(tok, "send", f"{HOST}/work/build.0", "echo hi", "--from", origin(core))
    page = sim.expect(lambda p: listed(p) and rows(p)[1].startswith("│ "), "the group", 20)
    sim.pick(1)
    sim.expect(titled("test-pane"), "the pane", 10)
    wait_for("following", lambda: following(sim), 10)
    check("Beside: build" in menu_labels(sim), menu_labels(sim))
    pick_menu(sim, "Beside: build")
    page = sim.expect(lambda p: p["kind"] == "dash" and col(p, 1) is not None, "the columns", 10)
    check("test-pane" in titles(page)[0] and "build" in titles(page)[1] and not any(t.startswith("» ") for t in titles(page)), titles(page))
    check(page["hint"].startswith("▽ pick a pane"), page["hint"])
    sim.shot("beside")
    sim.back()
    sim.expect(titled("test-pane"), "back on the pane", 10)
    sim.back()
    home(sim)


@test("F63", "Three hosts: a line per online host with its state and + session, the offline one in the hint; the program before what it says; a session from the host's line opens its pane, a second one named by voice, folded to the grammar", "UI")
def f63(run, name):
    def before(core):
        core.other_host("bob-desktop")
        core.other_host("carol-pc", False)
        core.new_window("notes", title="notes.md")
        core.keys("python3 -q", "Enter", target="work:notes.0")
    core, proxy, sim, tok = setup(run, name, sessions=True, before=before, read="*/*", write="*/*", stt=True, stt_text="My Scratch!!")
    page = sim.expect(lambda p: listed(p) and len(allrows(p)) == 4 and "python3" in allrows(p)[2], "the list", 30)
    check(allrows(page)[0] == f"── {HOST} · online · + session ──", allrows(page))
    check(allrows(page)[1] == "◌ bash · test-pane · quiet" or allrows(page)[1].startswith("◌ bash · test-pane · "), allrows(page))
    check(re.fullmatch(r"◌ python3 · notes\.md · (active|quiet \d+[smh])", allrows(page)[2]), allrows(page))
    check(allrows(page)[3] == "── bob-desktop · nothing exposed ──", allrows(page))
    check("○ carol-pc offline · " in page["hint"] and "bob-desktop" not in page["hint"], page["hint"])
    sim.shot("hosts")
    # A hold on a host's line selects nothing; a tap starts a session.
    sim.tap()
    page = sim.head(f"a session on {HOST}", "the name page", 10)
    check(page["items"][0] == "» glasses-1" and "type it on the phone" in page["hint"], (page["items"], page["hint"]))
    sim.shot("session-name")
    sim.choose(0)
    page = sim.head(f"start session glasses-1 on {HOST}?", "the confirmation", 10)
    check(page["items"] == ["Cancel", "Confirm"], page["items"])
    sim.choose(1)
    sim.expect(lambda p: any(b.get("name") == "state" and b["lines"][0] == "glasses-1/0.0" for b in p["blocks"]), "the session's pane open", 20)
    sim.shot("session-open")
    check([b for _, b in posts(proxy, "/sessions")] == [{"name": "glasses-1"}], posts(proxy, "/sessions"))
    check("glasses-1" in core.tmux_cmd("list-sessions"), core.tmux_cmd("list-sessions"))
    sim.back()
    page = sim.expect(lambda p: listed(p) and len(allrows(p)) == 5, "the new pane in the list", 20)
    check(any(r.startswith("◌ bash") and "glasses-1" not in r for r in allrows(page)), allrows(page))
    # A second session takes the next name, or one said aloud, folded to the grammar.
    sim.move(0, every=True)
    sim.tap()
    page = sim.head(f"a session on {HOST}", "the name page again", 10)
    check(page["items"] == ["» glasses-2", "» Say it"], page["items"])
    sim.choose(1)
    sim.head("listening", "listening for the name", 10)
    time.sleep(1.5)
    sim.tap()
    sim.head("heard this", "the name heard", 15)
    sim.tap()
    sim.head(f"start session my-scratch on {HOST}?", "the folded name", 10)
    sim.shot("session-folded")
    time.sleep(2.5)
    sim.choose(1)
    sim.expect(lambda p: any(b.get("name") == "state" and b["lines"][0] == "my-scratch/0.0" for b in p["blocks"]), "the second session's pane", 20)
    check([b for _, b in posts(proxy, "/sessions")] == [{"name": "glasses-1"}, {"name": "my-scratch"}], posts(proxy, "/sessions"))
    sim.back()
    home(sim)
    no_typing(proxy)


@test("F64", "Next and previous from a pane, round at the ends; + pane splits beside and opens the new one; Close pane with its confirmation, and end session on the last pane", "UI")
def f64(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
    core, proxy, sim, tok = setup(run, name, sessions=True, close=True, before=before)
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "three rows", 20)
    sim.pick(0)
    sim.expect(has_title("◌ bash · test-pane"), "the first pane", 10)
    wait_for("following", lambda: following(sim), 10)
    pick_menu(sim, "Next pane")
    sim.expect(has_title("◌ bash · build"), "the next pane", 10)
    wait_for("its place", lambda: sim.state() == "work/1.0", 10)
    pick_menu(sim, "Next pane")
    sim.expect(has_title("◌ bash · tests"), "the third pane", 10)
    sim.shot("next")
    pick_menu(sim, "Next pane")
    sim.expect(has_title("◌ bash · test-pane"), "round to the first", 10)
    pick_menu(sim, "Previous pane")
    sim.expect(has_title("◌ bash · tests"), "round back to the last", 10)
    wait_for("its place", lambda: sim.state() == "work/2.0", 10)
    # One more pane beside tests: the window is 80 x 24, so beside.
    pick_menu(sim, "+ pane")
    sim.head("one more pane beside tests?", "the split confirmation", 10)
    sim.choose(1)
    sim.expect(lambda p: any(b.get("name") == "state" and b["lines"][0] == "work/2.1" for b in p["blocks"]), "the new pane open", 20)
    check([(p, b) for p, b in posts(proxy, "/panes")] == [(f"/v1/windows/{HOST}/work/2/panes", {"direction": "h"})], posts(proxy, "/panes"))
    sim.shot("split")
    pick_menu(sim, "Close pane")
    page = sim.head(f"close ", "the close confirmation", 10)
    check(page["hint"].startswith("close ") and f"on {HOST}?" in page["hint"], page["hint"])
    sim.shot("close-confirm")
    sim.choose(1)
    page = sim.expect(lambda p: listed(p) and "closed" in p["hint"], "back on the list with the words", 15)
    sim.expect(lambda p: listed(p) and len(rows(p)) == 3, "the pane gone", 20)
    check(core.tmux_cmd("list-panes", "-t", "work:tests").count("\n") == 0, core.tmux_cmd("list-panes", "-t", "work:tests"))
    # A session's last pane: end session.
    sim.move(0, every=True)
    sim.tap()
    sim.head(f"a session on {HOST}", "the name page", 10)
    sim.choose(0)
    sim.head("start session glasses-1", "the confirmation", 10)
    time.sleep(2.5)  # one creation or close per two seconds
    sim.choose(1)
    sim.expect(lambda p: any(b.get("name") == "state" and b["lines"][0] == "glasses-1/0.0" for b in p["blocks"]), "the session's pane", 20)
    time.sleep(2.5)
    pick_menu(sim, "Close pane")
    sim.head(f"end session glasses-1 on {HOST}?", "the end session confirmation", 10)
    sim.shot("end-session")
    sim.choose(1)
    sim.expect(lambda p: listed(p) and "closed" in p["hint"], "closed", 15)
    wait_for("the session gone", lambda: "glasses-1" not in core.tmux_cmd("list-sessions"), 10)
    no_typing(proxy)


@test("F65", "The pane page leads with a permission's text, seven lines under it, paging by seven; the place in the state while following; read-only with the place for a reader", "UI")
def f65(run, name):
    def before(core):
        core.keys("for i in $(seq 1 30); do echo line $i; done", "Enter")
        core.notify("permission", "Claude needs your permission to use Bash")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "◆ inbox · 1 waiting", "the list", 20)
    sim.pick(1)
    sim.expect(titled("★ bash · test-pane"), "the pane", 10)
    page = sim.expect(lambda p: (sim.block("body", p) or [""])[0] == "★ Claude needs your permission to use Bash" and len([l for l in sim.block("body", p) if l]) >= 8, "the notice line", 10)
    body = sim.block("body", page)
    check(len(body) == 8 and body[-1].strip() == "$", body)
    check(sim.state() == "needs permission", sim.state())
    sim.shot("pane-notice")
    sim.scroll("up")
    # Seven lines a page: one page up ends at line 24, and the notice stays first; the state keeps the attention's word.
    page = sim.expect(lambda p: (sim.block("body", p) or [""])[-1] == "line 24", "paged by seven", 10)
    body = sim.block("body", page)
    check(body[0] == "★ Claude needs your permission to use Bash" and body[1] == "line 18", body)
    check(sim.state() == "needs permission", sim.state())
    sim.shot("pane-notice-paged")
    core.notify("working", "")
    page = sim.expect(lambda p: not (sim.block("body", p) or [""])[0].startswith("★ "), "the notice gone", 10)
    sim.menu(1)  # Bottom
    wait_for("the place", lambda: sim.state() == "work/0.0", 10)
    check(len([l for l in sim.block("body") if l]) == 8, sim.block("body"))
    sim.shot("pane-place")
    sim.close()
    run.cleanups.remove(sim.close)
    reader = core.token(read=f"{HOST}/*", write=None, name="reader")
    sim2 = Sim(run, name, run.static.url, {"hub": proxy.url, "token": reader, "every": 1})
    run.cleanups.append(sim2.close)
    home(sim2)
    sim2.pick(0)
    sim2.expect(titled("test-pane"), "the pane as a reader", 10)
    wait_for("read-only with the place", lambda: sim2.state() == "read-only · work/0.0", 10)
    sim2.shot("pane-readonly")


@test("F66", "The answers page with eight choices and Say it: nineteen rows, the keys and the commands behind two rows", "UI")
def f66(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True)
    open_pane(sim)
    ask = core.ask("which?", ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"])
    run.cleanups.append(ask.kill)
    wait_for("the question", lambda: "asks a question" in sim.state(), 10)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    items = page["items"]
    check(len(items) == 19, (len(items), items))
    check(items[:8] == [f"» c{i}" for i in range(1, 9)] and items[8] == "» Say it" and items[9] == "Enter", items)
    check(items[-2:] == ["→ keys", "→ commands: the shell's"], items[-2:])
    sim.shot("answers-full")
    sim.choose(17)
    page = sim.head("keys for test-pane", "the keys", 10)
    check(len(page["items"]) == 12, page["items"])
    sim.shot("keys")
    sim.back()
    sim.head("answer test-pane", "the answers again")
    ask.kill()


@test("F67", "The inbox with the notice's text and a question's choices under the rows; Go to takes the strictly oldest, an idle before a question; Later and Wake from the inbox's menu", "UI")
def f67(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("tests")
        core.notify("idle", "waiting at the prompt", "work:build.0")
        time.sleep(1.1)
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "◆ inbox · 1 waiting", "the list", 20)
    ask = core.ask("deploy to staging?", ["yes", "no"], target="work:tests.0")
    run.cleanups.append(ask.kill)
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "◆ inbox · 2 waiting", "both waiting", 20)
    sim.tap()
    page = sim.head("inbox · 2 waiting · ▽ move · ● open · ≡ later · ×× back", "the inbox page", 10)
    items = allrows(page)
    check(re.fullmatch(r"○ bash · build · idle · \d+s", items[0]) and items[1] == "    waiting at the prompt", items)
    check(re.fullmatch(r"★ bash · tests · asks a question · \d+s", items[2]) and items[3] == "    deploy to staging? » yes · no", items)
    check(page["menu"] and page["menu"][0]["label"] == "Later", page["menu"])
    sim.shot("inbox-text")
    sim.back()
    home(sim)
    # Go to: the idle pane waited longest, so it comes before the question.
    sim.pick(1)
    wait_for("the open pane", lambda: sim.block("state") is not None, 10)
    page = sim.last()
    if any(m["label"] == "Go to: build" for m in page["menu"]):
        pass
    else:
        wait_for("Go to in the menu", lambda: any(m["label"] == "Go to: build" for m in sim.last()["menu"]), 15)
    sim.shot("go-to-oldest")
    sim.back()
    home(sim)
    sim.pick(0)
    sim.head("inbox · 2 waiting", "the inbox page again", 10)
    sim.menu(0)
    page = sim.expect(lambda p: allrows(p) and allrows(p)[0].startswith("zz bash · build · later · idle"), "parked from the inbox", 15)
    check(any(p["hint"] == "parked" or "parked" in p["hint"] for p in sim.trace()[-6:]), "no words for the parking")
    sim.shot("inbox-parked")
    # The parked entry is last; the cursor stays on the first entry, now the question.
    page = sim.last()
    check(allrows(page)[0].startswith("★ bash · tests"), allrows(page))
    sim.scroll("down")
    wait_for("the parked entry under the cursor", lambda: sim.last()["menu"] and sim.last()["menu"][0]["label"] == "Wake", 10)
    sim.menu(0)
    sim.expect(lambda p: allrows(p) and allrows(p)[0].startswith("○ bash · build · idle"), "woken from the inbox", 15)
    laters = [b for _, b in posts(proxy, "/later")]
    check(laters == [{"later": True}, {"later": False}], laters)
    no_typing(proxy)
    ask.kill()


@test("F68", "The lens timing: a Codex pane works while its screen moves and is quiet ten seconds after; an idle while it moves draws no banner and shows working; working at once after a restart from the recent events", "UI")
def f68(run, name):
    core, proxy, sim, tok = setup(run, name, says="codex")
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "◌ Codex · test-pane · quiet", "quiet", 40)
    core.keys("while true; do echo tick; read -t 2 x; done", "Enter")
    page = sim.expect(lambda p: listed(p) and rows(p)[0] in ("◐ Codex · test-pane · working", "◑ Codex · test-pane · working"), "working from the screen", 25)
    sim.shot("lens-working")
    seen = len(sim.trace())
    core.notify("idle", "at the prompt")
    time.sleep(4)
    check(not any(p.get("hintBorder") for p in sim.trace()[seen:]), "a banner for an idle while the screen moves")
    # The idle puts the inbox row first; the pane's row is the one that names it.
    pane_row = lambda p: next((r for r in rows(p) if "test-pane" in r), "")
    check(pane_row(sim.last()) in ("◐ Codex · test-pane · working", "◑ Codex · test-pane · working"), rows(sim.last()))
    sim.shot("lens-idle-moving")
    core.keys("C-c")
    page = sim.expect(lambda p: listed(p) and pane_row(p) == "○ Codex · test-pane · idle", "idle once the screen is still", 40)
    sim.shot("lens-idle-still")
    # A restart: the recent events say working, so the pane is working before its next event.
    core.notify("working", "")
    sim.expect(lambda p: listed(p) and pane_row(p).endswith("· working"), "working from the event", 10)
    sim.close()
    run.cleanups.remove(sim.close)
    sim2 = Sim(run, name, run.static.url, {"hub": proxy.url, "token": tok, "every": 1})
    run.cleanups.append(sim2.close)
    page = home(sim2)
    check(rows(page)[0] in ("◐ Codex · test-pane · working", "◑ Codex · test-pane · working"), rows(page))
    check(not any(p.get("hintBorder") for p in sim2.trace()), "a toast after the restart")
    sim2.shot("lens-restart")


def unit_tests(run, results):
    start = time.time()
    r = subprocess.run(["node", "--test", "--test-reporter=tap", *sorted(str(p) for p in (harness.ROOT / "tests" / "unit").glob("*.test.ts"))],
                       capture_output=True, text=True, timeout=120, cwd=str(harness.ROOT))
    out = r.stdout + r.stderr
    (run.out / "logs").mkdir(parents=True, exist_ok=True)
    (run.out / "logs" / "unit.log").write_text(out)
    for m in re.finditer(r"^\s*(not ok|ok) \d+ - (.+)$", out, re.M):
        title = m.group(2).strip()
        if title.startswith("tests/unit/"):
            continue
        results.append({"id": "U01", "test": "U01_" + re.sub(r"\W+", "_", title)[:60], "title": title, "kind": "unit",
                        "ok": m.group(1) == "ok", "message": "" if m.group(1) == "ok" else out[-2000:], "seconds": time.time() - start})
    if not any(x["kind"] == "unit" for x in results):
        results.append({"id": "U01", "test": "U01_run", "title": "unit tests run", "kind": "unit", "ok": False,
                        "message": out[-2000:], "seconds": 0})


def secrets_in_logs(run, results):
    found = []
    for path in (run.out / "logs").rglob("*"):
        if path.is_file():
            text = path.read_text(errors="replace")
            found += [f"{path.relative_to(run.out)} ({s[:6]}...)" for s in run.secrets if len(s) > 12 and s in text]
    results.append({"id": "S99", "test": "S99_no_secret_in_any_log", "title": "No token or key in any log",
                    "kind": "e2e-security", "ok": not found, "message": "; ".join(found), "seconds": 0})


def report(run, results):
    passed = sum(r["ok"] for r in results)
    failed = len(results) - passed
    order = lambda r: (0 if r["kind"] == "e2e-security" else 1 if r["kind"] == "unit" else 2, r["id"])
    results.sort(key=order)
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    md = [f"## Test run {run.out.name}", "",
          f"**{'passed' if not failed else 'failed'}**: {len(results)} tests, {failed} failed. {when}", "",
          "| Test | Kind | Result | Time |", "|---|---|---|---|"]
    for r in results:
        md.append(f"| {r['test']} | {r['kind']} | {'pass' if r['ok'] else '**FAIL**'} | {r['seconds']:.1f}s |")
    (run.out / "summary.md").write_text("\n".join(md) + "\n")
    cases = []
    for r in results:
        body = "" if r["ok"] else f'<failure message="failed">{sax.escape(r["message"])}</failure>'
        cases.append(f'  <testcase name="{sax.escape(r["test"])}" classname="muxway-glasses-even" time="{r["seconds"]:.3f}">{body}</testcase>')
    (run.out / "results.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="{len(results)}" failures="{failed}" errors="0" '
        f'skipped="0">\n <testsuite name="muxway-glasses-even" tests="{len(results)}" failures="{failed}" errors="0" '
        f'skipped="0">\n' + "\n".join(cases) + "\n </testsuite>\n</testsuites>\n")
    rep = run.out / "report"
    rep.mkdir(exist_ok=True)
    parts = [f"<!doctype html><meta charset=utf-8><title>muxway-glasses-even test run</title><style>"
             "body{background:#000;color:#3f3;font:14px/1.4 monospace;margin:16px}"
             "h1,h2{font-weight:normal;border-bottom:1px solid #3f3}.fail{color:#f33}"
             "img{border:1px solid #3f3;margin:4px;background:#111}pre{white-space:pre-wrap;color:#fa3}"
             f"</style><h1>muxway-glasses-even test run {html.escape(run.out.name)}</h1>"
             f"<p>{len(results)} tests, {failed} failed, {when}</p>"]
    for r in results:
        cls = "" if r["ok"] else " class=fail"
        parts.append(f"<h2{cls}>[{'PASS' if r['ok'] else 'FAIL'}] {html.escape(r['test'])}: {html.escape(r['title'])}</h2>")
        if not r["ok"]:
            parts.append(f"<pre>{html.escape(r['message'])}</pre>")
        for shot in run.shots.get(r["test"], []):
            rel = os.path.relpath(shot, rep)
            width = 300 if "phone" in shot.stem else 576
            parts.append(f'<figure style="display:inline-block;vertical-align:top"><img src="{html.escape(rel)}" width={width}>'
                         f"<figcaption>{html.escape(shot.stem)}</figcaption></figure>")
    (rep / "index.html").write_text("\n".join(parts) + "\n")
    return failed


def main():
    out, binary, only = sys.argv[1], sys.argv[2], set(sys.argv[3:])
    run = Run(out, binary)
    results = []
    try:
        if not only or "U01" in only:
            unit_tests(run, results)
        for t in TESTS:
            if only and t["id"] not in only:
                continue
            name = f"{t['id']}_{t['fn'].__name__}"
            start = time.time()
            ok, message = True, ""
            try:
                t["fn"](run, name)
            except Exception as e:
                ok = False
                message = str(e) if isinstance(e, Failure) else f"{e}\n{traceback.format_exc(limit=3)}"
                for fn in run.cleanups:
                    if getattr(fn, "__self__", None).__class__.__name__ == "Sim":
                        try:
                            fn.__self__.shot("failure")
                        except Exception:
                            pass
            finally:
                for fn in reversed(run.cleanups):
                    try:
                        fn()
                    except Exception:
                        pass
                run.cleanups.clear()
            # A page the simulator refused never reached the glasses, whatever the trace says.
            refused = []
            for log in (run.out / "logs").glob(f"{name}*/simulator.log"):
                refused += [l.strip() for l in log.read_text(errors="replace").splitlines() if "validation failed" in l or "oversize" in l.lower()]
            if refused and ok:
                ok, message = False, f"the simulator refused a page: {refused[0][:200]}"
            results.append({"id": t["id"], "test": name, "title": t["title"], "kind": t["kind"], "ok": ok,
                            "message": message, "seconds": time.time() - start})
            print(f"{'PASS' if ok else 'FAIL'} {name} {message.splitlines()[0] if message else ''}", flush=True)
        secrets_in_logs(run, results)
    finally:
        run.close()
    sys.exit(1 if report(run, results) else 0)


if __name__ == "__main__":
    main()
