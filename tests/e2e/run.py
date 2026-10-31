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
        self.display = f":{90 + os.getpid() % 900}"
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
          revoke=False, before=None, says_claude=False, says=None, token=None, stt=False):
    logs = run.logs(name)
    hub_args = []
    transcriber = None
    if stt:
        transcriber = Transcriber(logs)
        run.cleanups.append(transcriber.close)
        hub_args = ["--stt-url", transcriber.url, "--stt-model", "whisper-base.en", "--stt-prompt", f"{HOST}, muxway"]
    core = Core(run, run.binary, logs, hub_args).start(expose=expose)
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


def rows(p):
    """The pane list's rows on screen, in order, without the cursor mark and the blank ones."""
    return [b["lines"][0][2:] for b in p["blocks"] if b.get("name", "").startswith("row") and b["lines"][0].strip()]


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
    sim.tap()
    page = sim.expect(lambda p: any(b.get("name") == "title" and name in b["lines"][0] for b in p["blocks"]), "the pane")
    wait_for("the pane's rows", lambda: "following" in sim.state() or "paused" in sim.state(), 10)
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
    sim.tap()
    page = sim.head("test-pane", "the pane")
    wait_for("following", lambda: "following" in sim.state(), 10)
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
    sim.menu(1)
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
    wait_for("a restart without a cursor", lambda: len(proxy.paths("/v1/events?limit=1")) >= 2, 20)
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
    check(items[0].startswith("· ★ "), f"the forged mark became the pane's: {items[0]}")
    check("read-only" in items[0] or items[0].endswith("…"), f"the forged mode was believed: {items[0]}")
    check(items[1].startswith("· tab here"), f"the tab survived as a tab: {items[1]}")
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
    # Every one of the 200 claims attention, so the inbox row leads them: 201 rows.
    page = sim.expect(lambda p: listed(p) and total(p) == 201, "the 200 panes", 20)
    check(len(rows(page)) == 7, f"{len(rows(page))} rows")
    for row in rows(page):
        check("-" not in row.split("·")[-1], f"a negative age: {row}")
    check(rows(page)[0] == "⚑ inbox · 200 waiting", rows(page)[0])
    check(page["charts"] == [] and page["hint"].startswith("⚑ 200 · 1–7 of 201 · "), f"the list page: {page['charts']} {page['hint']}")
    sim.shot("hostile-list")
    sim.move(9)
    page = sim.expect(lambda p: listed(p) and sim.cursor(p) == 9 and p["blocks"][0]["name"] == "row3", "the window slid")
    check(page["hint"].startswith("⚑ 200 · 4–10 of 201 · "), page["hint"])
    sim.shot("hostile-list-slid")
    time.sleep(1)
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S31", "Pane JSON with a 1 MiB title and nested junk: parsed or skipped, polling goes on", "e2e-security")
def s31(run, name):
    core, proxy, sim, tok = setup(run, name, mode="list-junk")
    # The body is over the app's cap, so the listing is cut and parsed as empty, or parsed with the one pane: either is fine.
    page = sim.expect(lambda p: listed(p) and total(p) <= 1, "the listing survived", 20)
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
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2 and rows(p)[1].startswith("★ test-pane"), "the question in the list", 20)
    check(rows(page)[0] == "⚑ inbox · 1 waiting", rows(page))
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
    wait_for("back on the pane", lambda: "following" in sim.state() or "paused" in sim.state(), 10)
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
    page = sim.expect(lambda p: listed(p) and len(rows(p)) == 2, "two rows")
    check(rows(page)[0].startswith("● logs") and rows(page)[0].endswith("· done · read-only"), f"rows: {rows(page)}")
    check(rows(page)[1].startswith("· test-pane · bash · active"), f"rows: {rows(page)}")
    sim.shot("list")
    for i in range(10):
        core.new_window(f"w{i:02d}")
    page = sim.expect(lambda p: listed(p) and total(p) == 12 and len(rows(p)) == 7, "a full window", 25)
    check(page["blocks"][0]["name"] == "row0" and sim.cursor(page) == 0, "the window moved without the cursor")
    sim.shot("list-full")
    sim.move(11)
    page = sim.expect(lambda p: listed(p) and sim.cursor(p) == 11, "the cursor at the end")
    # Addresses sort as text, so work/10.0 and work/11.0 come before work/2.0 and w07 is last.
    check(page["blocks"][0]["name"] == "row5" and rows(page)[-1].startswith("· w07"), f"the window did not slide: {rows(page)}")
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
    page = sim.head("following", "following again")
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
    sim.tap()
    page = sim.expect(lambda p: (sim.block("body", p) or [""])[-1] == "* pong", "the lens", 15)
    body = sim.block("body", page)
    check(len(body) == 8, f"{len(body)} lines")
    check(not any("fix the typo" in l for l in body), "the suggestion is on the pane")
    check(not any("auto mode" in l or "Crunched" in l for l in body), "chrome in the body")
    check(any("claude" in t for t in titles(page)), f"the title does not name the program: {titles(page)}")
    check(page["charts"] == [], "a picture on the pane")
    sim.shot("lens")
    sim.menu(1)
    sim.expect(lambda p: any("auto mode" in l for l in (sim.block("body", p) or [])), "reveal all", 10)
    sim.shot("lens-reveal")
    sim.menu(1)
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
    page = sim.expect(lambda p: listed(p) and len(rows(p)) > 1 and rows(p)[1].startswith("★ build"), "build first among the panes")
    check(rows(page)[0] == "⚑ inbox · 1 waiting", rows(page)[0])
    check(rows(page)[1] == "★ build · bash · needs permission", rows(page)[1])
    sim.shot("list-attention")  # the toast still holds the hint here; the count in it is F41's
    core.notify("working", "", "work:build.0")
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("★") or i.startswith("⚑") for i in rows(p)), "cleared", 8)
    check(any(i.startswith("· build · bash · ") and ("working" in i or "active" in i or "quiet" in i) for i in rows(page)), rows(page))
    check(not page["hint"].startswith("⚑"), page["hint"])
    sim.shot("list-cleared")


@test("F17", "Hub down and host offline: said on the pane, recovered when back", "UI")
def f17(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    core.stop("agent")
    sim.head("host offline", "host offline", 15)
    sim.shot("host-offline")
    core.start_agent()
    wait_for("following again", lambda: "following" in sim.state(), 15)
    core.stop("hub")
    sim.expect(lambda p: "hub unreachable" in words(p) or "no connection" in words(p), "hub down", 15)
    sim.shot("hub-down")
    core.start_hub()
    core.start_agent()
    wait_for("recovered", lambda: "following" in sim.state(), 40)
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
    check(rows(page)[0] == "⚑ inbox · 3 waiting", rows(page))
    check(rows(page)[1] == "★ test-pane · bash · asks a question", rows(page))
    check(rows(page)[2] == "★ build · bash · needs permission", rows(page))
    check(rows(page)[3] == "● tests · bash · done", rows(page))
    check(rows(page)[4] in ("· logs · bash · active", "· logs · bash · quiet 1m"), rows(page))
    sim.shot("list-attention")
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "list" and p["hint"].startswith("inbox · 3 waiting"), "the inbox page", 10)
    items = page["items"]
    check([i.rsplit(" · ", 1)[0] for i in items] == ["★ build · bash · needs permission", "★ test-pane · bash · asks a question", "● tests · bash · done"], items)
    check(all(re.search(r" · \d+s$", i) for i in items), f"no age on a row: {items}")
    check(any(r["path"] == "/v1/inbox" for r in proxy.requests), "the inbox was not read from the hub")
    sim.shot("inbox")
    sim.choose(1)
    wait_for("the second pane", lambda: sim.block("state") is not None, 10)
    check(sim.state() == "asks a question", sim.state())
    check(any("test-pane" in t for t in titles(sim.last())), titles(sim.last()))
    sim.shot("inbox-pane")
    sim.back()
    sim.expect(lambda p: p["kind"] == "list" and p["hint"].startswith("inbox · "), "back on the inbox", 10)
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
    wait_for("the state cleared", lambda: "following" in sim.state(), 10)
    sim.shot("answered")
    sim.back()
    page = sim.expect(lambda p: listed(p) and not any(i.startswith("⚑") for i in rows(p)), "nothing waits", 10)


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
    check(rows(page)[0] == "⚑ inbox · 2 waiting", rows(page))
    check(page["hint"].startswith("⚑ 2 · "), page["hint"])
    sim.shot("inbox-row")
    sim.tap()
    page = sim.expect(lambda p: p["kind"] == "list" and p["hint"].startswith("inbox · 2 waiting"), "the inbox page", 10)
    check([i.rsplit(" · ", 1)[0] for i in page["items"]] == ["★ build · bash · needs permission", "★ tests · bash · asks a question"], page["items"])
    sim.shot("inbox")
    sim.back()
    home(sim)
    # The quiet pane: its menu's Go to names the pane that has waited longest.
    sim.pick(3)
    sim.expect(lambda p: any(b.get("name") == "title" and "test-pane" in b["lines"][0] for b in p["blocks"]), "test-pane")
    wait_for("following", lambda: "following" in sim.state(), 10)
    page = sim.last()
    check(any(m["label"] == "Go to: build" for m in page["menu"]), page["menu"])
    sim.shot("go-to-oldest")


@test("F42", "A Codex pane is named Codex in the list and on the pane; working from its event", "UI")
def f42(run, name):
    core, proxy, sim, tok = setup(run, name, says="codex")
    page = home(sim)
    check(rows(page)[0].startswith("· test-pane · Codex · "), rows(page))
    core.notify("working", "", "work:0.0")
    page = sim.expect(lambda p: listed(p) and rows(p)[0] == "· test-pane · Codex · working", "working", 8)
    sim.shot("list-codex")
    sim.tap()
    page = sim.expect(lambda p: any(b.get("name") == "title" and b["lines"][0] == "· test-pane · Codex" for b in p["blocks"]), "the pane names Codex", 10)
    sim.shot("pane-codex")


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
    check(rows(page) == ["· test-pane · bash · active", "· build · bash · active", "· logs · bash · active", "· more · bash · active"], rows(page))
    sim.hold(0)
    page = sim.expect(lambda p: listed(p) and rows(p)[0].startswith("[x] · test-pane"), "selection mode, test-pane selected")
    check(rows(page)[1:] == ["[ ] · build · bash · active", "[ ] · logs · bash · active", "[ ] · more · bash · active", "→ clear selection"], rows(page))
    check(page["hint"].startswith("▽ move · ● select · 3 at most"), page["hint"])
    sim.pick(1)
    page = sim.expect(lambda p: listed(p) and rows(p)[1].startswith("[x] · build"), "build selected by a tap")
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
    page = sim.expect(lambda p: listed(p) and rows(p)[2].startswith("[x] · logs"), "logs selected")
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
