"""
End-to-end harness: a throwaway tmux server, the muxway hub and agent built
from the core repository, a recording proxy in front of the hub that can
misbehave on purpose, the built page served from dist/, and the Even Hub
simulator on a headless X display, driven through its automation API.
Every drawn page reaches the console as a trace line (?trace=1 from
loopback), which is what the assertions read.
"""

import functools
import http.client
import http.server
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIM = ROOT / "node_modules" / "@evenrealities" / "sim-linux-x64" / "bin" / "evenhub-simulator"
HOST = "alice-laptop"
FIXTURES = ROOT / "tests" / "e2e" / "fixtures"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(what, cond, timeout=20.0, every=0.2):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what}")


class Failure(AssertionError):
    pass


def check(cond, message):
    if not cond:
        raise Failure(message)


# --- muxway core ---------------------------------------------------------------

class Core:
    """Hub, agent and tmux for one test."""

    def __init__(self, run, binary, logs, hub_args=()):
        self.run, self.bin, self.logs = run, binary, logs
        self.hub_args = list(hub_args)
        self.dir = Path(run.tmp) / secrets.token_hex(4)
        self.dir.mkdir(mode=0o700)
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.tmux = f"mxw-glasses-{os.getpid()}-{secrets.token_hex(3)}"
        self.procs = {}

    def cli(self, *args):
        out = subprocess.run([str(self.bin), *args], capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            raise RuntimeError(f"muxway {' '.join(args[:3])}: {out.stderr.strip()}")
        return out.stdout.strip()

    def spawn(self, name, *args):
        log = open(self.logs / f"{name}.log", "a")
        self.procs[name] = subprocess.Popen([str(self.bin), *args], stdout=log, stderr=log)

    def stop(self, name):
        p = self.procs.pop(name, None)
        if p:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    def tmux_cmd(self, *args):
        return subprocess.run(["tmux", "-L", self.tmux, *args], capture_output=True, text=True, timeout=10).stdout.strip()

    def start(self, expose="--write"):
        shell = "env -i PATH=/usr/bin:/bin TERM=xterm LANG=C.UTF-8 PS1='$ ' bash --norc --noprofile"
        self.tmux_cmd("-f", "/dev/null", "new-session", "-d", "-s", "work", "-n", "shell", "-x", "80", "-y", "24", shell)
        self.tmux_cmd("select-pane", "-t", "work:0.0", "-T", "test-pane")
        self.start_hub()
        code = self.cli("hub", "pair-code", "--dir", str(self.dir / "hub"), "--host", HOST)
        self.cli("agent", "pair", "--dir", str(self.dir / "agent"), code)
        self.start_agent()
        self.expose("work:0.0", expose)
        return self

    def start_hub(self):
        self.spawn("hub", "hub", "serve", "--dir", str(self.dir / "hub"), "--listen", f"127.0.0.1:{self.port}",
                   "--public-url", self.url, *self.hub_args)
        wait_for("hub", lambda: (self.dir / "hub" / "admin.sock").exists())

    def start_agent(self):
        self.spawn("agent", "agent", "run", "--dir", str(self.dir / "agent"), "--tmux-name", self.tmux)
        wait_for("agent online", lambda: f"{HOST}\tonline" in self.cli("hub", "agents", "--dir", str(self.dir / "hub")))

    def expose(self, target, flag="--write"):
        args = ["expose", "--tmux-name", self.tmux, "-t", target] + ([flag] if flag else [])
        self.cli(*args)

    def token(self, read=f"{HOST}/*", write=f"{HOST}/*", name="glasses"):
        args = ["hub", "token", "create", "--dir", str(self.dir / "hub"), "--name", name, "--read", read]
        if write:
            args += ["--write", write]
        tok = self.cli(*args)
        self.run.secrets.append(tok)
        return tok

    def revoke_all(self):
        for line in self.cli("hub", "token", "list", "--dir", str(self.dir / "hub")).splitlines()[1:]:
            self.cli("hub", "token", "revoke", "--dir", str(self.dir / "hub"), line.split()[0])

    def new_window(self, name, title=None, expose="--write"):
        """A new window with one pane, exposed; returns its target."""
        self.tmux_cmd("new-window", "-d", "-t", "work", "-n", name,
                      "env -i PATH=/usr/bin:/bin TERM=xterm LANG=C.UTF-8 PS1='$ ' bash --norc --noprofile")
        target = f"work:{name}.0"
        self.tmux_cmd("select-pane", "-t", target, "-T", title or name)
        self.expose(target, expose)
        return target

    def pane_id(self, target="work:0.0"):
        return self.tmux_cmd("display-message", "-p", "-t", target, "#{pane_id}")

    def notify(self, kind, text, target="work:0.0"):
        """What a Claude Code hook does: muxway notify on the host, inside the pane."""
        self.cli("notify", "--dir", str(self.dir / "agent"), "--pane", self.pane_id(target), "--kind", kind, "--text", text)

    def keys(self, *keys, target="work:0.0"):
        self.tmux_cmd("send-keys", "-t", target, *keys)

    def pane(self, target="work:0.0"):
        return self.tmux_cmd("capture-pane", "-p", "-t", target)

    def command(self, target="work:0.0"):
        return self.tmux_cmd("display-message", "-p", "-t", target, "#{pane_current_command}")

    def close(self):
        for name in list(self.procs):
            self.stop(name)
        self.tmux_cmd("kill-server")
        for key in ("hub/hub.key", "agent/agent.key"):
            p = self.dir / key
            if p.exists():
                self.run.secrets.append(p.read_text().strip())
        shutil.rmtree(self.dir, ignore_errors=True)


# --- proxy ---------------------------------------------------------------------------

# What the hub makes of Claude Code's characters for a Latin-1 client.
ASCII_ART = {"─": "-", "━": "-", "═": "=", "❯": ">", "●": "*", "·": ".",
             "⏵": ">", "←": "<", "→": ">", "↓": "v", "…": "...", "✻": "*",
             "✳": "*", "└": "+", "┐": "+", "┘": "+", "┌": "+"}


def spelt(screen, path):
    """The screen the way the hub answers the charset in the request's query: body bytes and headers."""
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
    charset = query.get("charset", ["utf-8"])[0]
    if charset == "utf-8":
        return screen.encode(), {"Content-Type": "text/plain; charset=utf-8"}
    out = "".join(ASCII_ART.get(c, c if ord(c) < (256 if charset == "latin1" else 128) else "?") for c in screen)
    mime = "iso-8859-1" if charset == "latin1" else "us-ascii"
    return out.encode("latin-1"), {"Content-Type": f"text/plain; charset={mime}"}


def hostile_claude_screen():
    """A screen shaped like Claude Code's by a server that means harm: a 400
    column rule, a thousand short ones, control characters in the box and a
    footer that lies. Under the app's cap, so the box survives."""
    rows = [f"transcript row {i}" for i in range(30)]
    rows.append("─" * 400)
    rows += ["─" * 5] * 1000
    rows.append("❯ box \x1b[31mred\x1b[0m \x07bell \x00nul")
    rows.append("─" * 80)
    rows.append("  fake footer: call +15555550100 now")
    return ("\n".join(rows) + "\n").encode()


CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag"}


class Proxy:
    """A loopback proxy in front of the hub that records every request.
    Modes make it misbehave on purpose for the security tests."""

    def __init__(self, hub_url, logs, mode="normal"):
        self.hub = hub_url.replace("http://", "")
        self.mode = mode
        self.slowed = False
        # The list names the program claude, so the lens is forced by it.
        self.says_claude = False
        self.log = open(logs / "proxy.log", "a")
        self.requests = []
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def forward(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                path = self.path
                proxy.requests.append({"method": self.command, "path": path, "body": body, "headers": dict(self.headers),
                                       "at": time.time()})
                proxy.log.write(f"{time.strftime('%H:%M:%S')} {self.command} {path} headers={sorted(k.lower() for k in self.headers.keys())} body={len(body)}\n")
                proxy.log.flush()
                bare = path.split("?")[0]
                is_read = self.command == "GET" and bare.startswith("/v1/panes/")
                if proxy.mode == "slow-list" and bare == "/v1/panes" and self.command == "GET" and not proxy.slowed:
                    # The first listing takes a while: the app has to say so meanwhile.
                    proxy.slowed = True
                    time.sleep(4)
                if proxy.mode == "big" and is_read:
                    return self.reply(200, b"x" * (1 << 20) + b"\n", {"Content-Type": "text/plain; charset=utf-8", **CORS})
                if proxy.mode == "garbage" and is_read:
                    return self.reply(200, b"ok \xff\xfe\xc3 \x1b[31mred\x1b[0m \x07bell \x00nul\r\nend\n",
                                      {"Content-Type": "text/plain; charset=utf-8", **CORS})
                if proxy.mode in ("claude", "claude-empty") and is_read:
                    screen = (FIXTURES / "claude-code.txt").read_text()
                    if proxy.mode == "claude-empty":
                        screen = screen.replace("❯ fix the typo in README", "❯")
                    data, headers = spelt(screen, path)
                    return self.reply(200, data, {**headers, **CORS})
                if proxy.mode == "claude-hostile" and is_read:
                    return self.reply(200, hostile_claude_screen(), {"Content-Type": "text/plain", **CORS})
                if proxy.mode == "stt-hostile" and bare == "/v1/transcribe" and self.command != "OPTIONS":
                    if self.command == "GET":
                        return self.reply(204, b"", CORS)
                    text = "run \x1b[31mthe\x07 tests " + "y" * 10000 + "\n"
                    return self.reply(200, text.encode(), {"Content-Type": "text/plain; charset=utf-8", **CORS})
                if proxy.mode == "stt-lies" and bare == "/v1/transcribe" and self.command != "OPTIONS":
                    if self.command == "GET":
                        return self.reply(204, b"", CORS)
                    return self.reply(502, b'{"error":"provider_unavailable"}', {"Content-Type": "application/json", **CORS})
                if proxy.mode == "events-hostile" and self.command == "GET" and bare == "/v1/events" and "after=" in path:
                    n = sum(1 for r in proxy.requests if r["method"] == "GET" and r["path"].startswith("/v1/events?after="))
                    time.sleep(1)
                    if n == 1:
                        body_json = {"events": [
                            {"seq": 7, "at": 1767225600, "address": HOST + "/work/0.0", "kind": "permission", "text": "needs \x1b[1myou\x07 " + "y" * 10000},
                            {"seq": 8, "at": 1767225601, "address": HOST + "/work/0.0", "kind": "nonsense", "text": "x"}], "next": 8}
                    elif n == 2:
                        body_json = {"next": "abc"}
                    else:
                        body_json = {"next": 9}
                    return self.reply(200, json.dumps(body_json).encode(), {"Content-Type": "application/json", **CORS})
                headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection")}
                try:
                    c = http.client.HTTPConnection(proxy.hub, timeout=40)
                    c.request(self.command, path, body=body or None, headers=headers)
                    r = c.getresponse()
                    data = r.read()
                except OSError:
                    return self.reply(502, b'{"error":"hub_unreachable"}\n', {"Content-Type": "application/json", **CORS})
                if proxy.mode == "lie-writable" and bare == "/v1/panes":
                    data = data.replace(b'"mode":"read"', b'"mode":"write"')
                if proxy.says_claude and bare == "/v1/panes":
                    data = data.replace(b'"command":"bash"', b'"command":"claude"')  # the program says claude
                if proxy.mode == "lie-title" and bare == "/v1/panes":
                    # Titles a program could choose: one that looks like a pane that needs you and may be written to,
                    # one with a tab, one far too long, and one of three-byte glyphs that reach the byte limit first.
                    pane = lambda **kw: {"address": f"{HOST}/work/0.0", "mode": "read", "command": "bash", "activity": int(time.time()), **kw}
                    data = json.dumps({"panes": [
                        pane(title=f"\u2605 {HOST}/work/0.0 claude write permission"),
                        pane(title="tab\there"),
                        pane(mode="write", title="x" * 300),
                        pane(mode="write", title="\u2605" * 40),
                        pane(mode="write", title="\u00bb held"),
                    ]}).encode()
                if proxy.mode == "list-hostile" and bare == "/v1/panes":
                    now = int(time.time())
                    panes = [{"address": f"{HOST}/work/{i}.0", "mode": "write", "command": "bash", "title": "t" * 300,
                              "activity": now + 31536000 if i % 2 else -5,
                              "attention": {"kind": "permission", "at": 0, "text": "x" * 500}} for i in range(200)]
                    data = json.dumps({"panes": panes}).encode()
                if proxy.mode == "list-junk" and bare == "/v1/panes":
                    data = json.dumps({"panes": [{"address": f"{HOST}/work/0.0", "mode": "write", "command": "bash", "title": "j" * (1 << 20),
                                                 "attention": {"kind": {"deep": [1, 2]}, "at": "x"}, "activity": [1]}, None, 7, {"address": 5}],
                                       "extra": {"a": {"b": {"c": list(range(1000))}}}}).encode()
                keep = ("etag", "content-type", "access-control-allow-origin", "access-control-allow-methods",
                        "access-control-allow-headers", "access-control-expose-headers", "access-control-max-age")
                self.reply(r.status, data, {k: v for k, v in r.getheaders() if k.lower() in keep})

            def reply(self, status, data, headers):
                proxy.log.write(f"    -> {status} {len(data)} bytes\n")
                try:
                    self.send_response(status)
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    if data:
                        self.wfile.write(data)
                except OSError:
                    pass  # the app gave up on the request

            do_GET = do_POST = do_OPTIONS = forward

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def paths(self, prefix):
        return [r for r in self.requests if r["path"].startswith(prefix)]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# --- a stand-in transcriber ------------------------------------------------------------

class Transcriber:
    """What whisper.cpp's server answers: a fixed sentence for any clip, and
    a record of every clip it was given."""

    def __init__(self, logs, text="run the tests again"):
        self.text = text
        self.clips = []
        self.log = open(logs / "transcriber.log", "a")
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}/v1/audio/transcriptions"
        stt = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                wav = body[body.find(b"RIFF"):] if b"RIFF" in body else b""
                end = wav.find(b"\r\n--")
                wav = wav[:end] if end > 0 else wav
                stt.clips.append(wav)
                stt.log.write(f"{time.strftime('%H:%M:%S')} clip {len(wav)} bytes\n")
                stt.log.flush()
                data = json.dumps({"text": stt.text}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# --- the page --------------------------------------------------------------------------

class Static:
    """Serves dist/ on loopback, as the Even app would serve a packed page, and
    takes the app's trace: one POST per drawn page, kept per simulator."""

    def __init__(self):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.traces = {}
        static = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=str(ROOT / "dist"), **kw)

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                m = re.fullmatch(r"/trace/([a-z0-9]{1,32})", self.path)
                if m:
                    try:
                        static.traces.setdefault(m.group(1), []).append(json.loads(body))
                    except ValueError:
                        pass
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def pages(self, trace_id):
        return [t["page"] for t in sorted(self.traces.get(trace_id, []), key=lambda t: t["seq"])]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def direct(hub_url, token, method, path, body=None, accept="text/plain"):
    """One request straight to the hub or proxy, outside the app."""
    req = urllib.request.Request(hub_url + path, data=body.encode() if body else None, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", accept)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# --- the simulator ---------------------------------------------------------------------

def words(page):
    """Every word a page shows: head, hint, blocks, the bands' text."""
    parts = [page["head"], page["hint"]]
    parts += [l for b in page["blocks"] for l in b["lines"]]
    parts += [c["text"] for c in page.get("charts", []) if c.get("text")]
    return "\n".join(parts)

class Sim:
    """The Even Hub simulator showing the page, driven through its automation API."""

    def __init__(self, run, test, page_url, params):
        self.run, self.test = run, test
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.shots = run.screens(test)
        self.step = 0
        self.entries = []
        # Pages drawn before the last gesture do not count for an expectation: a stale page
        # that happens to match would let a test run ahead of the glasses.
        self.mark = 0
        self.out = open(run.logs(test) / "simulator.log", "a")
        self.id = secrets.token_hex(6)
        self.static = run.static
        url = page_url + "/?" + urllib.parse.urlencode({"trace": self.id, **params})
        # A home of its own: the WebView's storage must not carry one test's settings into the next.
        self.home = Path(run.tmp) / ("sim-" + secrets.token_hex(4))
        self.home.mkdir()
        env = {**os.environ, "DISPLAY": run.display, "WEBKIT_DISABLE_COMPOSITING_MODE": "1",
               "WEBKIT_DISABLE_DMABUF_RENDERER": "1", "LIBGL_ALWAYS_SOFTWARE": "1", "HOME": str(self.home),
               "XDG_DATA_HOME": str(self.home / "data"), "XDG_CACHE_HOME": str(self.home / "cache"),
               "XDG_CONFIG_HOME": str(self.home / "config")}
        self.proc = subprocess.Popen([str(SIM), url, "--automation-port", str(self.port)], stdout=self.out,
                                     stderr=subprocess.STDOUT, env=env)
        wait_for("simulator", self.alive, 40, 0.5)
        wait_for("first page", lambda: len(self.trace()) > 0, 20, 0.3)

    def alive(self):
        try:
            return self.api("GET", "/api/ping") == b"pong"
        except OSError:
            return False

    def api(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body else None, method=method)
        if body:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()

    def console(self):
        since = self.entries[-1]["id"] + 1 if self.entries else 0
        try:
            d = json.loads(self.api("GET", f"/api/console?since_id={since}"))
        except OSError:
            return self.entries
        self.entries += d.get("entries", [])
        return self.entries

    def trace(self):
        """Every page the app drew, oldest first, as the app posted them to the harness.
        The simulator's own console drops lines under load, so it is read only for errors."""
        return self.static.pages(self.id)

    def last(self):
        t = self.trace()
        check(t, "the app drew nothing")
        return t[-1]

    def expect(self, pred, what, timeout=25):
        """Waits for a drawn page the predicate accepts, newest first, and returns it."""
        found = []

        def seen():
            for p in reversed(self.trace()[self.mark:]):
                if pred(p):
                    found.append(p)
                    return True
            return False
        try:
            wait_for(what, seen, timeout, 0.3)
        except AssertionError:
            last = self.trace()[-1:]
            raise Failure(f"{what}: no page matched; last: {json.dumps(last)[:600]}")
        return found[0]

    def head(self, text, what=None, timeout=25):
        """A page that says the text somewhere: head, hint, a block or a title band."""
        return self.expect(lambda p: text in words(p), what or f"a page saying {text!r}", timeout)

    def block(self, name, page=None):
        """The lines of the named block on the page (the last one by default), or None."""
        page = page or self.last()
        for b in page["blocks"]:
            if b.get("name") == name:
                return b["lines"]
        return None

    def state(self):
        s = self.block("state")
        return s[0] if s else ""

    def lit(self):
        """How much of the glasses is lit, 0 to 1, from a screenshot."""
        path = Path(self.run.tmp) / f"lit-{secrets.token_hex(3)}.png"
        path.write_bytes(self.api("GET", "/api/screenshot/glasses"))
        out = subprocess.run(["identify", "-format", "%[fx:mean]", str(path)], capture_output=True, text=True)
        path.unlink(missing_ok=True)
        return float(out.stdout.strip() or 0)

    def lines(self):
        """The lines of pane text on screen now: the body, then the pinned block."""
        p = self.last()
        return [l for b in p["blocks"] if b.get("name") in ("body", "pinned") for l in b["lines"]]

    def input(self, action, wait=0.8):
        self.mark = len(self.trace())
        self.api("POST", "/api/input", {"action": action})
        time.sleep(wait)

    def scroll(self, direction, wait=1.0):
        """One scroll on a page without a list. The simulator reports one scroll per two ticks there,
        but which tick is the second depends on what came before, so a tick that drew nothing within
        a moment is followed by another."""
        self.mark = len(self.trace())
        for _ in range(3):
            self.api("POST", "/api/input", {"action": direction})
            end = time.time() + 1.0
            while time.time() < end and len(self.trace()) == self.mark:
                time.sleep(0.1)
            if len(self.trace()) > self.mark:
                break
        time.sleep(wait)

    def tap(self, wait=1.0):
        """A tap, and a second one when the first drew nothing within a moment: the firmware drops
        an input that arrives while a rebuild is being applied, and so does the simulator."""
        self.mark = len(self.trace())
        self.api("POST", "/api/input", {"action": "click"})
        end = time.time() + 1.5
        while time.time() < end and len(self.trace()) == self.mark:
            time.sleep(0.1)
        if len(self.trace()) == self.mark:
            self.api("POST", "/api/input", {"action": "click"})
        time.sleep(wait)

    def back(self, wait=1.0):
        self.input("double_click", wait)

    def choose(self, index, wait=1.0):
        """Moves the list highlight from the top to the index-th row and taps it."""
        for _ in range(index):
            self.api("POST", "/api/input", {"action": "down"})
            time.sleep(0.3)
        self.tap(wait)

    def cursor(self, page=None):
        """The pane list's cursor: the index of its brightest row."""
        page = page or self.last()
        for b in page["blocks"]:
            if b.get("name", "").startswith("row") and b["level"] == 4:
                return int(b["name"][3:])
        return 0

    def move(self, index):
        """Scrolls the pane list's cursor to the index-th row, one drawn page per tick."""
        for _ in range(40):
            at = self.cursor()
            if at == index:
                return
            self.scroll("down" if index > at else "up", 0.3)
        check(self.cursor() == index, f"the cursor is on row {self.cursor()}, not {index}")

    def pick(self, index, wait=1.0):
        """Moves the pane list's cursor to the index-th row and taps it."""
        self.move(index)
        self.tap(wait)

    def hold(self, index, wait=1.0):
        """Moves the pane list's cursor to the index-th row and holds it: a long press and its release."""
        self.move(index)
        self.mark = len(self.trace())
        self.api("POST", "/api/input", {"action": "long_press"})
        time.sleep(0.4)
        self.api("POST", "/api/input", {"action": "long_press_release"})
        time.sleep(wait)

    def menu(self, index, wait=1.5):
        """Opens the OS menu and picks its index-th entry."""
        self.api("POST", "/api/input", {"action": "context_menu"})
        time.sleep(1.0)
        for _ in range(index):
            self.api("POST", "/api/input", {"action": "down"})
            time.sleep(0.3)
        self.tap(wait)

    def shot(self, name):
        self.step += 1
        path = self.shots / f"{self.step:02d}-{name}.png"
        time.sleep(0.6)  # the trace runs ahead of the glasses by a rebuild and its pictures
        try:
            path.write_bytes(self.api("GET", "/api/screenshot/glasses"))
            self.run.add_shot(self.test, path)
        except OSError:
            pass
        return path

    def web(self, name):
        self.step += 1
        path = self.shots / f"{self.step:02d}-{name}-phone.png"
        try:
            path.write_bytes(self.api("GET", "/api/screenshot/webview"))
            self.run.add_shot(self.test, path)
        except OSError:
            pass

    def close(self):
        try:
            entries = self.console()
            with open(self.run.logs(self.test) / "console.log", "w") as f:
                for e in entries:
                    f.write(f"{e['id']} {e['level']} {e['message']}\n")
            with open(self.run.logs(self.test) / "trace.log", "w") as f:
                for p in self.trace():
                    f.write(json.dumps(p, ensure_ascii=False) + "\n")
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.out.close()
