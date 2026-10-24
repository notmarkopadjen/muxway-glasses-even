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
from harness import HOST, Core, Failure, Proxy, Sim, Static, check, direct, wait_for  # noqa: E402

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
          revoke=False, before=None, says_claude=False, token=None):
    logs = run.logs(name)
    core = Core(run, run.binary, logs).start(expose=expose)
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
    all_params.update(params or {})
    sim = Sim(run, name, run.static.url, all_params)
    run.cleanups.append(sim.close)
    return core, proxy, sim, tok


def open_pane(sim, name="test-pane"):
    sim.expect(lambda p: p["kind"] == "list" and any(name in i for i in p["items"]), "pane list")
    sim.shot("panes")
    sim.tap()
    page = sim.head(name + " · ", "the pane")
    wait_for("the pane's rows", lambda: "following" in sim.last()["head"] or "paused" in sim.last()["head"], 10)
    sim.shot("pane")
    return page


# --- security -----------------------------------------------------------------------

@test("S01", "Wrong and revoked tokens: refused once, forgotten, no retry", "e2e-security")
def s01(run, name):
    core, proxy, sim, tok = setup(run, name, revoke=True)
    sim.head("token refused", "the refusal", 20)
    sim.shot("refused")
    time.sleep(6)
    sim.web("phone-after-refusal")
    tried = [r for r in proxy.requests if r["headers"].get("Authorization") == "Bearer " + tok]
    check(1 <= len(tried) <= 2, f"the revoked token was tried {len(tried)} times")
    check(time.time() - max(r["at"] for r in tried) > 4, "the app went on trying a refused token")
    check(not any(tok in r["path"] for r in proxy.requests), "the token appeared in a URL")
    # A wrong token on a fresh start: the same once.
    sim.close()
    run.cleanups.remove(sim.close)
    wrong = "mxt_" + "x" * 43
    before = len(proxy.requests)
    sim2 = Sim(run, name, run.static.url, {"hub": proxy.url, "token": wrong, "every": 1})
    run.cleanups.append(sim2.close)
    sim2.head("token refused", "the refusal of a wrong token", 20)
    time.sleep(5)
    tried = [r for r in proxy.requests[before:] if r["headers"].get("Authorization") == "Bearer " + wrong]
    check(1 <= len(tried) <= 2, f"the wrong token was tried {len(tried)} times")


@test("S03", "Read-only token: no answers, a direct write is refused", "e2e-security")
def s03(run, name):
    core, proxy, sim, tok = setup(run, name, write=None)
    page = sim.expect(lambda p: p["kind"] == "list" and p["items"], "pane list")
    check(any("read-only" in i for i in page["items"]), f"no read-only mark: {page['items']}")
    sim.shot("panes")
    sim.tap()
    page = sim.head("test-pane · ", "the pane")
    check("refresh" in page["hint"] and "answer" not in page["hint"], f"hint offers an answer: {page['hint']}")
    sim.tap()
    time.sleep(1.5)
    check(sim.last()["kind"] == "text", "a tap on a read-only pane opened a list")
    sim.shot("pane")
    status, body = direct(proxy.url, tok, "POST", f"/v1/panes/{HOST}/work/0.0/input", '{"text":"y"}')
    check(status == 403, f"a direct write got {status}")
    check(not any(r["method"] == "POST" for r in proxy.requests if r["headers"].get("Origin") is not None
                  and r["path"].endswith("/input") and "Authorization" in r["headers"] and r["body"]), "the app wrote")


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
    check(len(page["blocks"]) == 2, f"the box was not pinned: {page['blocks']}")
    pinned = page["blocks"][1]["lines"]
    check(any("box" in l and "bell" in l for l in pinned), f"the box is not the pinned row: {pinned}")
    check(not any("fake footer" in l for b in page["blocks"] for l in b["lines"]), "the footer was shown unasked")
    check(not re.search(r"[\x00-\x08\x0a-\x1f\x7f]", json.dumps(page)), "control characters reached the screen")
    sim.shot("hostile")
    sim.menu(1)
    page = sim.expect(lambda p: any("fake footer" in l for b in p["blocks"] for l in b["lines"]), "reveal all", 10)
    sim.shot("revealed")
    check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")


@test("S06", "Hostile events: escapes and 10 KiB of text become one fitted toast; a bad cursor restarts", "e2e-security")
def s06(run, name):
    core, proxy, sim, tok = setup(run, name, mode="events-hostile")
    page = sim.expect(lambda p: p["hintLevel"] == 4, "the toast", 30)
    check(page["hint"].startswith("★ test-pane: needs "), f"toast: {page['hint'][:80]}")
    check(len(page["hint"]) <= 260 and "\x1b" not in page["hint"] and "\x07" not in page["hint"], "the toast is not clean")
    sim.shot("toast")
    wait_for("a restart without a cursor", lambda: len(proxy.paths("/v1/events?limit=1")) >= 2, 20)
    wait_for("polling goes on", lambda: len(proxy.paths("/v1/events?after=")) >= 3, 20)
    check(not any(e["level"] == "error" and "uncaught" in e["message"] for e in sim.console()), "an uncaught error")


@test("S07", "Pane titles with a forged mark, tabs, 300 characters and wide glyphs: rows clamped, marks their own", "e2e-security")
def s07(run, name):
    core, proxy, sim, tok = setup(run, name, mode="lie-title")
    page = sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 4, "the four rows", 20)
    for row in page["items"]:
        check(len(row.encode()) <= 63, f"a row of {len(row.encode())} bytes: {row}")
    check(page["items"][0].startswith("· ★ "), f"the forged mark became the pane's: {page['items'][0]}")
    check(page["items"][0].endswith("…") or "read-only" in page["items"][0], f"the forged mode was believed: {page['items'][0]}")
    check(page["items"][1].startswith("· tab ·"), f"the tab's column shift was believed: {page['items'][1]}")
    check("needs you" not in page["head"], f"a title raised attention: {page['head']}")
    time.sleep(1)
    sim.shot("rows")
    check(not any("refused" in e["message"] for e in sim.console()), "the firmware refused the page")


@test("S02", "The token is in no URL, no console line and on no screen", "e2e-security")
def s02(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    time.sleep(2)
    check(not any(tok in r["path"] for r in proxy.requests), "the token appeared in a URL")
    check(all(r["headers"].get("Authorization") == "Bearer " + tok for r in proxy.requests
              if r["method"] != "OPTIONS"), "a request without the bearer token")
    text = "\n".join(e["message"] for e in sim.console())
    check(tok not in text, "the token appeared in the console")
    check(tok not in json.dumps(sim.trace()), "the token appeared on the glasses")
    sim.web("phone")


# --- features -------------------------------------------------------------------------

@test("F10", "Pane list with marks and read-only; nineteen rows and the next page", "UI")
def f10(run, name):
    def before(core):
        core.new_window("logs", expose=None)
        core.notify("done", "tests passed", "work:logs.0")
    core, proxy, sim, tok = setup(run, name, before=before)
    page = sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 2, "two panes")
    check(page["items"][0].startswith("● logs") and "read-only" in page["items"][0], f"rows: {page['items']}")
    check(page["items"][1].startswith("· test-pane · bash"), f"rows: {page['items']}")
    check(page["head"] == "muxway · 2 panes", page["head"])
    sim.shot("panes")
    for i in range(20):
        core.new_window(f"w{i:02d}")
    made = time.strftime("%H:%M:%S")
    try:
        page = sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 20, "a full page", 25)
    except Failure as e:
        st, body = direct(proxy.url, tok, "GET", "/v1/panes")
        raise Failure(f"{e}\nwindows made at {made}; direct list now: {st} {len(body.splitlines())} panes; "
                      f"tmux: {core.tmux_cmd('list-windows')[:300]}")
    check(page["items"][19].startswith("→ next 3 more"), page["items"][19])
    sim.shot("panes-full")
    sim.choose(19)
    page = sim.expect(lambda p: p["kind"] == "list" and len(p["items"]) == 3, "the next page")
    sim.shot("panes-2")


@test("F11", "Open a pane, read its last lines, see a new line within the follow interval", "UI")
def f11(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    check(any(l.startswith("$") for l in sim.lines()), f"no prompt on screen: {sim.lines()}")
    n = len(proxy.paths("/v1/panes/"))
    wait_for("three more reads", lambda: len(proxy.paths("/v1/panes/")) >= n + 3, 10)
    core.keys("echo hello", "Enter")
    t0 = time.time()
    sim.expect(lambda p: any(l == "hello" for b in p["blocks"] for l in b["lines"]), "hello on the glasses", 6)
    sim.shot("pane-hello")
    reads = proxy.paths("/v1/panes/")
    check(len(reads) >= n + 3, "the pane was not followed")
    check(any(r["headers"].get("If-None-Match") for r in reads), "no If-None-Match on a follow-up read")
    check(time.time() - t0 < 6, "the new line took too long")


@test("F12", "Scroll up pages back and pauses following; down past the end follows again", "UI")
def f12(run, name):
    core, proxy, sim, tok = setup(run, name)
    core.keys("seq 1 40", "Enter")
    open_pane(sim)
    sim.expect(lambda p: any(l == "40" for b in p["blocks"] for l in b["lines"]), "the sequence")
    sim.shot("bottom")
    sim.scroll("up")
    page = sim.head("paused · 1 page up", "one page up")
    check("40" not in [l for b in page["blocks"] for l in b["lines"]], "the view did not move")
    sim.shot("one-up")
    sim.scroll("up")
    sim.head("paused · 2 pages up", "two pages up")
    n = len(proxy.paths("/v1/panes/"))
    time.sleep(3)
    check(len(proxy.paths("/v1/panes/")) == n, "the pane was read while paused")
    sim.scroll("down")
    sim.scroll("down")
    page = sim.head("following", "following again")
    check("40" in [l for b in page["blocks"] for l in b["lines"]], "the bottom did not come back")
    sim.shot("bottom-again")


@test("F13", "Answers: y confirmed reaches the pane, Cancel sends nothing, Ctrl-C stops a command", "UI")
def f13(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    sim.tap()
    page = sim.head("answer test-pane", "the answers")
    check(page["items"][1] == "y ⏎", page["items"])
    sim.shot("answers")
    sim.choose(1)
    page = sim.head("send y ⏎ to test-pane?", "the confirmation")
    check(page["items"] == ["Cancel", "Confirm"], page["items"])
    sim.shot("confirm")
    sim.choose(1)
    sim.head("sent y ⏎", "the flash", 10)
    wait_for("y typed", lambda: "y: command not found" in core.pane(), 5)
    sim.expect(lambda p: any("y: command not found" in l for b in p["blocks"] for l in b["lines"]), "the pane after", 8)
    sim.shot("pane-after")
    posts = [r for r in proxy.requests if r["method"] == "POST"]
    check([json.loads(r["body"]) for r in posts] == [{"text": "y"}, {"key": "Enter"}], f"posts: {[r['body'] for r in posts]}")
    # Cancel sends nothing.
    sim.tap()
    sim.head("answer test-pane", "the answers again")
    sim.choose(0)
    sim.head("send ⏎ Enter to test-pane?", "the confirmation")
    sim.choose(0)
    sim.head("test-pane · bash", "back on the pane")
    time.sleep(1)
    check(len([r for r in proxy.requests if r["method"] == "POST"]) == 2, "Cancel sent something")
    # Ctrl-C stops sleep.
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


@test("F14", "The Claude Code lens: chrome hidden, the box pinned when typed, reveal all", "UI")
def f14(run, name):
    core, proxy, sim, tok = setup(run, name, mode="claude", says_claude=True)
    sim.expect(lambda p: p["kind"] == "list" and any("claude" in i for i in p["items"]), "pane list names claude")
    sim.tap()
    page = sim.expect(lambda p: len(p["blocks"]) == 2, "the pinned box")
    body = page["blocks"][0]["lines"]
    check(body[-1] == "* pong", f"body ends with {body[-1]!r}")
    check(page["blocks"][1]["lines"] == ["> fix the typo in README"], page["blocks"][1]["lines"])
    check(not any("auto mode" in l or "Crunched" in l for l in body), "chrome in the body")
    sim.shot("lens")
    sim.menu(1)
    page = sim.expect(lambda p: any("auto mode" in l for b in p["blocks"] for l in b["lines"]), "reveal all", 10)
    check(len(page["blocks"]) == 1, "reveal pinned something")
    sim.shot("lens-reveal")
    sim.menu(1)
    sim.expect(lambda p: len(p["blocks"]) == 2, "the lens again", 10)
    sim.shot("lens-again")


@test("F15", "A notification: toast within two seconds, the pane first in the list, cleared by working", "UI")
def f15(run, name):
    core, proxy, sim, tok = setup(run, name, before=lambda c: c.new_window("build"))
    open_pane(sim)
    t0 = time.time()
    core.notify("permission", "Claude needs your permission to use Bash", "work:build.0")
    page = sim.expect(lambda p: p["hintLevel"] == 4, "the toast", 8)
    check(time.time() - t0 < 4, f"the toast took {time.time() - t0:.1f} s")
    check(page["hint"] == "★ build: Claude needs your permission to use Bash", page["hint"])
    check(any(m["label"] == "Needs you: build" for m in page["menu"]), page["menu"])
    sim.shot("toast")
    sim.back()
    page = sim.expect(lambda p: p["kind"] == "list" and p["items"] and p["items"][0].startswith("★ build"), "build first")
    check("1 needs you" in page["head"], page["head"])
    sim.shot("panes-attention")
    core.notify("working", "", "work:build.0")
    page = sim.expect(lambda p: p["kind"] == "list" and any(i.startswith("· build") for i in p["items"]), "cleared", 8)
    check(not any(i.startswith("★") for i in page["items"]), page["items"])
    check("needs you" not in page["head"], page["head"])
    sim.shot("panes-cleared")


@test("F17", "Hub down and host offline: said in the head, recovered when back", "UI")
def f17(run, name):
    core, proxy, sim, tok = setup(run, name)
    open_pane(sim)
    core.stop("agent")
    sim.head("host offline", "host offline", 15)
    sim.shot("host-offline")
    core.start_agent()
    sim.head("following", "following again", 15)
    core.stop("hub")
    sim.expect(lambda p: "hub unreachable" in p["head"] or "no connection" in p["head"], "hub down", 15)
    sim.shot("hub-down")
    core.start_hub()
    core.start_agent()
    sim.head("following", "recovered", 40)
    sim.shot("recovered")


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
            results.append({"id": t["id"], "test": name, "title": t["title"], "kind": t["kind"], "ok": ok,
                            "message": message, "seconds": time.time() - start})
            print(f"{'PASS' if ok else 'FAIL'} {name} {message.splitlines()[0] if message else ''}", flush=True)
        secrets_in_logs(run, results)
    finally:
        run.close()
    sys.exit(1 if report(run, results) else 0)


if __name__ == "__main__":
    main()
