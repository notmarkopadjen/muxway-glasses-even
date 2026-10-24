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
          revoke=False, before=None, says_claude=False, token=None, stt=False):
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
    proxy.says_claude = says_claude
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


def home(sim, timeout=25):
    """The ring's first page, Needs you, once the first listing is in: a gesture before that lands
    while the page is still being built and is dropped."""
    sim.expect(lambda p: p["kind"] == "dash" and p["head"].startswith("[★"), "Needs you", timeout)
    return sim.expect(lambda p: p["kind"] == "dash" and p["head"].startswith("[★") and "≡ 0 " not in p["head"] and sim.block("footer", p) is not None, "the first listing", timeout)


def open_pane(sim, name="test-pane"):
    """From the start: a tap on Needs you opens the first pane."""
    home(sim)
    sim.shot("needs-you")
    sim.tap()
    page = sim.expect(lambda p: any(c.get("text", "").find(name) >= 0 for c in p["charts"]) or any(b.get("name") == "title" for b in p["blocks"]), "the pane")
    wait_for("the pane's rows", lambda: "following" in sim.state() or "paused" in sim.state(), 10)
    sim.shot("pane")
    return page


def open_list(sim):
    """From the start: scroll to the Panes page, tap for the list."""
    home(sim)
    sim.scroll("down")
    sim.expect(lambda p: p["kind"] == "dash" and "[≡" in p["head"], "the Panes page")
    sim.shot("panes-dash")
    sim.tap()
    return sim.expect(lambda p: p["kind"] == "list" and p["items"], "the list")


def to_split(sim):
    """From the start: two scrolls to the columns."""
    home(sim)
    sim.scroll("down")
    sim.expect(lambda p: "[≡" in p["head"], "the Panes page")
    sim.scroll("down")
    return sim.expect(lambda p: p["kind"] == "dash" and "[□□" in p["head"], "the columns")


def col(page, i):
    for b in page["blocks"]:
        if b.get("name") == f"col{i}":
            return b
    return None


def band_texts(page):
    return [c["text"] for c in page["charts"] if c.get("text")]


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
    check(any("read-only" in i for i in page["items"]), f"no read-only mark: {page['items']}")
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


@test("S05", "Hostile Claude Code screen: at most the chrome hidden, nothing crashes, reveal shows all", "e2e-security")
def s05(run, name):
    core, proxy, sim, tok = setup(run, name, mode="claude-hostile", params={"charset": "utf-8"})
    open_pane(sim)
    page = sim.last()
    pinned = sim.block("pinned", page)
    check(pinned, "the box was not pinned")
    check(any("box" in l and "bell" in l for l in pinned), f"the box is not the pinned row: {pinned}")
    check(not any("fake footer" in l for l in sim.lines()), "the footer was shown unasked")
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(page)), "control characters reached the screen")
    sim.shot("hostile")
    sim.menu(1)
    sim.expect(lambda p: any("fake footer" in l for b in p["blocks"] for l in b["lines"]), "reveal all", 10)
    sim.shot("revealed")
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
    check(len(page["items"]) == 4, f"rows: {page['items']}")
    for row in page["items"]:
        check(len(row.encode()) <= 63, f"a row of {len(row.encode())} bytes: {row}")
    check(page["items"][0].startswith("· ★ "), f"the forged mark became the pane's: {page['items'][0]}")
    check("read-only" in page["items"][0] or page["items"][0].endswith("…"), f"the forged mode was believed: {page['items'][0]}")
    check(page["items"][1].startswith("· tab here"), f"the tab survived as a tab: {page['items'][1]}")
    check("★ 1" not in page["head"], f"a title raised attention: {page['head']}")
    time.sleep(1)
    sim.shot("rows")
    check(not any("refused" in e["message"] for e in sim.console()), "the firmware refused the page")


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


@test("S30", "A listing of 200 panes with long titles and times out of range: five rows, bars clamped, page accepted", "e2e-security")
def s30(run, name):
    core, proxy, sim, tok = setup(run, name, mode="list-hostile")
    page = home(sim)
    page = sim.expect(lambda p: "≡ 200" in p["head"], "the 200 panes", 20)
    rows = [sim.block(f"row{i}", page) for i in range(5)]
    check(all(r and r[0].strip() for r in rows), f"rows: {rows}")
    check(sim.block("row5", page) is None, "a sixth row")
    check(len(page["charts"]) == 1, "the bars")
    sim.shot("hostile-needs")
    sim.scroll("down")
    page = sim.expect(lambda p: "[≡" in p["head"], "the Panes page")
    check("195 more in the list" in "".join(sim.block("footer", page)), sim.block("footer", page))
    sim.shot("hostile-panes")
    time.sleep(1)
    check(not any("refused" in e["message"] or "uncaught" in e["message"] for e in sim.console()), "the firmware refused a page")


@test("S31", "Pane JSON with a 1 MiB title and nested junk: parsed or skipped, polling goes on", "e2e-security")
def s31(run, name):
    core, proxy, sim, tok = setup(run, name, mode="list-junk")
    # The body is over the app's cap, so the listing is cut and parsed as empty, or parsed with the one pane: either is fine.
    page = sim.expect(lambda p: "≡ 1" in p["head"] or ("≡ 0" in p["head"] and sim.block("footer", p) is not None), "the listing survived", 20)
    row = sim.block("row0", page)
    check(row is None or len(row[0]) < 200, f"row: {row}")
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
    page = sim.expect(lambda p: "listening" in sim.state() and len(p["charts"]) >= 3, "the graph", 5)
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
    page = open_list(sim)
    check(len(page["items"]) == 2, page["items"])
    check(page["items"][0].startswith("● logs") and "read-only" in page["items"][0], f"rows: {page['items']}")
    check(page["items"][1].startswith("· test-pane · bash"), f"rows: {page['items']}")
    check("≡ 2" in page["head"], page["head"])
    sim.shot("list")
    for i in range(20):
        core.new_window(f"w{i:02d}")
    page = sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 20, "a full page", 25)
    check(page["items"][19].startswith("→ next 3 more"), page["items"][19])
    sim.shot("list-full")
    sim.choose(19)
    sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 3, "the next page")
    sim.shot("list-2")


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


@test("F12", "Scroll up pages back and pauses following; down past the end follows again; the position bar moves", "UI")
def f12(run, name):
    core, proxy, sim, tok = setup(run, name)
    core.keys("seq 1 40", "Enter")
    open_pane(sim)
    sim.expect(lambda p: any(l == "40" for l in (sim.block("body", p) or [])), "the sequence")
    bar0 = [c["key"] for c in sim.last()["charts"] if c["key"].startswith("pos:")]
    sim.shot("bottom")
    sim.scroll("up")
    page = sim.head("paused · 1 page up", "one page up")
    check("40" not in (sim.block("body", page) or []), "the view did not move")
    bar1 = [c["key"] for c in page["charts"] if c["key"].startswith("pos:")]
    check(bar0 != bar1, "the position bar did not move")
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


@test("F14", "The Claude Code lens: chrome hidden, the box pinned and framed, reveal all", "UI")
def f14(run, name):
    core, proxy, sim, tok = setup(run, name, mode="claude", says_claude=True)
    home(sim)
    sim.expect(lambda p: "≡ 1" in p["head"], "the list read")
    sim.tap()
    page = sim.expect(lambda p: sim.block("pinned", p) is not None, "the pinned box", 15)
    body = sim.block("body", page)
    check(body[-1] == "* pong", f"body ends with {body[-1]!r}")
    check(sim.block("pinned", page) == ["> fix the typo in README"], sim.block("pinned", page))
    check(any(b.get("name") == "pinned" and b.get("border") for b in page["blocks"]), "the box has no frame")
    check(not any("auto mode" in l or "Crunched" in l for l in body), "chrome in the body")
    check(any("claude" in t for t in band_texts(page)), f"the band does not name the program: {band_texts(page)}")
    sim.shot("lens")
    sim.menu(1)
    page = sim.expect(lambda p: any("auto mode" in l for l in (sim.block("body", p) or [])), "reveal all", 10)
    check(sim.block("pinned", page) is None, "reveal pinned something")
    sim.shot("lens-reveal")
    sim.menu(1)
    sim.expect(lambda p: sim.block("pinned", p) is not None, "the lens again", 10)
    sim.shot("lens-again")


@test("F15", "A notification: a banner within two seconds, the pane first on Needs you, cleared by working", "UI")
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
    page = sim.expect(lambda p: "[★ 1]" in p["head"] and (sim.block("row0", p) or [""])[0].startswith("★ build"), "build first on Needs you")
    check("needs permission" in sim.block("row0", page)[0], sim.block("row0", page))
    check(len(page["charts"]) == 1, "no timeline")
    sim.shot("needs-you-attention")
    core.notify("working", "", "work:build.0")
    page = sim.expect(lambda p: "[★ 0]" in p["head"] and "nothing needs you" in "".join(sim.block("footer", p) or []), "cleared", 8)
    sim.shot("needs-you-cleared")


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


@test("F30", "The ring: Needs you, Panes, Side by side by scrolling; a double tap on the columns returns to Needs you", "UI")
def f30(run, name):
    core, proxy, sim, tok = setup(run, name, before=lambda c: c.new_window("build"))
    page = home(sim)
    sim.expect(lambda p: "≡ 2" in p["head"], "the list read")
    check(page["head"].startswith("[★ "), page["head"])
    sim.shot("ring-needs-you")
    sim.scroll("down")
    page = sim.expect(lambda p: "[≡ 2]" in p["head"], "Panes")
    check(any("2 panes on 1 host" in l for l in sim.block("footer", page)), sim.block("footer", page))
    check(len(page["charts"]) == 1, "no bars")
    sim.shot("ring-panes")
    sim.scroll("down")
    page = sim.expect(lambda p: "[□□ 2]" in p["head"] and col(p, 1) is not None, "Side by side")
    check(len(band_texts(page)) == 2, band_texts(page))
    sim.shot("ring-split")
    sim.back()
    sim.expect(lambda p: p["head"].startswith("[★ "), "back to Needs you")
    sim.scroll("up")
    time.sleep(1)
    check(sim.last()["head"].startswith("[★ "), "scrolling up from the first page moved")


@test("F31", "Needs you with two panes waiting: rows, the timeline, tap opens the first", "UI")
def f31(run, name):
    def before(core):
        core.new_window("build")
        core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
        core.notify("question", "Which file?", "work:0.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: "[★ 2]" in p["head"] and (sim.block("row1", p) or [""])[0].startswith("★"), "two rows", 20)
    rows = [sim.block(f"row{i}", page)[0] for i in range(2)]
    check(rows[0].startswith("★ build · bash · needs permission") or rows[0].startswith("★ test-pane"), rows)
    check(any("★ 2 ask" in l for l in sim.block("footer", page)), sim.block("footer", page))
    check(page["charts"][0]["key"].startswith("needs:"), page["charts"][0]["key"])
    sim.shot("needs-you")
    sim.tap()
    wait_for("the first pane", lambda: sim.block("state") is not None, 10)
    check(any("needs permission" in t or "asks a question" in t for t in [sim.state()]), sim.state())
    sim.shot("first-pane")


@test("F32", "Side by side: two panes follow; the scroll selects; past the last column the columns slide; tap opens the answers", "UI")
def f32(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("logs")
        core.keys("echo left-side", "Enter")
        core.keys("echo right-side", "Enter", target="work:build.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = to_split(sim)
    page = sim.expect(lambda p: any("left-side" in l for l in (col(p, 0) or {"lines": []})["lines"]) and any("right-side" in l for l in (col(p, 1) or {"lines": []})["lines"]), "both columns read", 15)
    check(not any(t.startswith("»") for t in band_texts(page)), "a column selected before any scroll")
    sim.shot("split")
    core.keys("echo later", "Enter")
    sim.expect(lambda p: any("later" in l for l in (col(p, 0) or {"lines": []})["lines"]), "the left column follows", 8)
    sim.scroll("down")
    page = sim.expect(lambda p: band_texts(p) and band_texts(p)[0].startswith("»"), "the first column selected")
    sim.shot("split-first")
    sim.scroll("down")
    page = sim.expect(lambda p: len(band_texts(p)) == 2 and band_texts(p)[1].startswith("»"), "the second column selected")
    sim.shot("split-second")
    sim.scroll("down")
    page = sim.expect(lambda p: len(band_texts(p)) == 2 and band_texts(p)[1].startswith("»") and "logs" in band_texts(p)[1], "slid to the third pane")
    check("build" in band_texts(page)[0], band_texts(page))
    sim.shot("split-slid")
    sim.tap()
    sim.head("answer logs", "the answers of the selected pane")
    sim.shot("split-answers")
    sim.back()
    sim.expect(lambda p: "[□□" in p["head"], "back on the columns")


@test("F33", "Double tap expands the selected pane, scroll pages it, double tap returns to the columns; then the main menu; three columns", "UI")
def f33(run, name):
    def before(core):
        core.new_window("build")
        core.new_window("logs")
        core.keys("seq 1 40", "Enter", target="work:build.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    to_split(sim)
    sim.scroll("down")
    sim.scroll("down")
    sim.expect(lambda p: len(band_texts(p)) == 2 and band_texts(p)[1].startswith("»") and "build" in band_texts(p)[1], "build selected")
    sim.back()
    page = sim.expect(lambda p: sim.block("state", p) is not None and any("build" in t for t in band_texts(p)), "build full", 10)
    wait_for("the sequence", lambda: "40" in (sim.block("body") or []), 10)
    sim.shot("split-full")
    sim.scroll("up")
    sim.head("paused · 1 page up", "paged")
    sim.back()
    page = sim.expect(lambda p: "[□□" in p["head"], "back on the columns")
    check(not any(t.startswith("»") for t in band_texts(page)), "a column still selected")
    sim.shot("split-back")
    sim.back()
    sim.expect(lambda p: p["head"].startswith("[★ "), "the main menu")
    sim.menu(2)
    page = sim.expect(lambda p: "[□□ 2]" in p["head"], "Side by side from the menu")
    sim.menu(3)
    page = sim.expect(lambda p: "[□□ 3]" in p["head"] and col(p, 2) is not None, "three columns", 10)
    check(len(band_texts(page)) == 3, band_texts(page))
    sim.shot("split-three")


@test("F35", "Listening: the graph grows with the tone and the progress bar advances; heard this in its box", "UI")
def f35(run, name):
    core, proxy, sim, tok = setup(run, name, stt=True)
    open_pane(sim)
    say_it(sim)
    time.sleep(1)
    lit0 = sim.lit()
    k0 = [c["key"] for c in sim.last()["charts"] if c["key"].startswith("progress:")]
    time.sleep(3)
    lit1 = sim.lit()
    page = sim.last()
    k1 = [c["key"] for c in page["charts"] if c["key"].startswith("progress:")]
    check(lit1 > lit0, f"the graph did not grow: {lit0:.4f} -> {lit1:.4f}")
    check(k0 != k1, "the progress bar did not advance")
    check(any(c["key"].startswith("levels:") for c in page["charts"]), "no graph")
    sim.shot("listening-graph")
    sim.tap()
    page = sim.head("heard this", "the transcript", 15)
    check(any(b.get("name") == "text" and b.get("border") for b in page["blocks"]), "the transcript has no box")
    check(any("heard this" in t for t in band_texts(page)), band_texts(page))
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
