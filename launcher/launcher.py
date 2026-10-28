#!/usr/bin/python3
"""Cobra run launcher: a small root daemon that runs one agent step (claude-code, codex or git) as the team's
own Linux user, cobra-run-<tenantId>, inside a hardened transient systemd unit.

Protocol (one request per connection on a unix socket, 0660 root:cobra; only peer uid == cobra is served):
  client -> one JSON line {tenantId, runId, engine, args, env, workspace, timeoutSec, mkdir, files, readBack, rmAfter}
  server -> JSON lines {"t":"o","d":<text>} (stdout+stderr, in order) ... then {"t":"x","code":N,"files":{...}}
            or {"t":"e","error":<msg>} when the request is refused. Closing the connection stops the run.
Secrets (env values, args, file contents) travel only over the socket and the unit's stdin: never in argv,
unit properties, files outside the team dir, or logs. No shell is ever involved."""
import json, os, pwd, grp, re, signal, socket, sqlite3, struct, subprocess, sys, threading, uuid

CONF = {
    "socket": os.environ.get("COBRA_LAUNCHER_SOCKET", "/run/cobra-launcher.sock"),
    "teams_root": os.environ.get("COBRA_TEAMS_ROOT", "/srv/cobra-teams"),
    "db": os.environ.get("COBRA_DB_PATH", "/var/lib/cobra/cobra.db"),
    "client_user": os.environ.get("COBRA_LAUNCHER_CLIENT", "cobra"),
    "stage": os.environ.get("COBRA_LAUNCHER_STAGE", "/usr/local/lib/cobra-launcher/stage.py"),
    "tools_bin": os.environ.get("COBRA_TOOLS_BIN", "/opt/cobra-tools/bin"),
    "memory_max": os.environ.get("COBRA_RUN_MEMORY_MAX", "3G"),
    "cpu_quota": os.environ.get("COBRA_RUN_CPU_QUOTA", "200%"),
    "tasks_max": os.environ.get("COBRA_RUN_TASKS_MAX", "512"),
}
ENGINES = {"claude-code": "claude", "codex": "codex", "git": None}  # git -> /usr/bin/git
ENV_ALLOW = {"GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GH_TOKEN",
             "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "CODEX_HOME"}
GIT_KEY = "http.https://github.com/.extraheader"
RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_REQ = 16 * 1024 * 1024
MAX_TIMEOUT = 6 * 3600
INACCESSIBLE = ["/etc/cobra", "/var/lib/cobra", "/home/cobra", "/root", CONF["socket"]]


class Refused(Exception):
    pass


def run_user(tid):
    return f"cobra-run-{tid}"


def team_dir(tid):
    return os.path.join(CONF["teams_root"], str(tid))


def tenant_exists(tid):
    con = sqlite3.connect(f"file:{CONF['db']}?mode=ro", uri=True, timeout=5)
    try:
        return con.execute("SELECT 1 FROM tenants WHERE id = ?", (tid,)).fetchone() is not None
    finally:
        con.close()


def rel_ok(p):
    return isinstance(p, str) and 0 < len(p) < 500 and not p.startswith("/") and ".." not in p.split("/") and "\0" not in p


def validate(req, peer_uid, client_uid, exists=tenant_exists):
    """Returns the normalized request or raises Refused. Pure apart from the tenant lookup."""
    if peer_uid != client_uid:
        raise Refused("peer not allowed")
    if not isinstance(req, dict):
        raise Refused("bad request")
    tid = req.get("tenantId")
    if not isinstance(tid, int) or isinstance(tid, bool) or tid <= 0 or tid > 10**9:
        raise Refused("bad tenantId")
    run_id = req.get("runId")
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise Refused("bad runId")
    engine = req.get("engine")
    if engine not in ENGINES:
        raise Refused("engine not allowed")
    args = req.get("args")
    if not isinstance(args, list) or not all(isinstance(a, str) and "\0" not in a for a in args) or len(args) > 200:
        raise Refused("bad args")
    ws = os.path.join(team_dir(tid), "workspaces", run_id)
    w = req.get("workspace")
    if not isinstance(w, str) or os.path.normpath(w) != ws or ".." in w.split("/"):
        raise Refused("workspace outside the team dir")
    env = req.get("env") or {}
    if not isinstance(env, dict):
        raise Refused("bad env")
    for k, v in env.items():
        if k not in ENV_ALLOW:
            raise Refused(f"env not allowed: {k}")
        if not isinstance(v, str) or "\0" in v:
            raise Refused(f"bad env value: {k}")
    if "GIT_CONFIG_KEY_0" in env and env["GIT_CONFIG_KEY_0"] != GIT_KEY:
        raise Refused("git config key not allowed")
    if "CODEX_HOME" in env and not os.path.normpath(env["CODEX_HOME"]).startswith(ws + "/"):
        raise Refused("CODEX_HOME outside the workspace")
    t = req.get("timeoutSec", 600)
    if not isinstance(t, int) or isinstance(t, bool) or not 1 <= t <= MAX_TIMEOUT:
        raise Refused("bad timeoutSec")
    files = req.get("files") or []
    if not isinstance(files, list) or not all(isinstance(f, dict) and rel_ok(f.get("path")) and isinstance(f.get("content"), str) for f in files):
        raise Refused("bad files")
    for key in ("readBack", "rmAfter"):
        v = req.get(key) or []
        if not isinstance(v, list) or not all(rel_ok(p) for p in v):
            raise Refused(f"bad {key}")
    if not exists(tid):
        raise Refused("unknown tenant")
    return {"tenantId": tid, "runId": run_id, "engine": engine, "args": args, "env": env, "workspace": ws,
            "timeoutSec": t, "mkdir": bool(req.get("mkdir")), "files": files,
            "readBack": req.get("readBack") or [], "rmAfter": req.get("rmAfter") or []}


def ensure_team(tid):
    """Creates cobra-run-<tid> (system user, own group, nologin, no password, home = team dir) and the 0700 team dir."""
    name, home = run_user(tid), team_dir(tid)
    try:
        pw = pwd.getpwnam(name)
    except KeyError:
        subprocess.run(["useradd", "--system", "--user-group", "--home-dir", home, "--no-create-home",
                        "--shell", "/usr/sbin/nologin", name], check=True, stdin=subprocess.DEVNULL, capture_output=True)
        pw = pwd.getpwnam(name)
    os.makedirs(CONF["teams_root"], mode=0o755, exist_ok=True)
    try:
        os.mkdir(home, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(home)
    if not os.path.isdir(home) or os.path.islink(home):
        raise Refused("team dir is not a directory")
    if st.st_uid != pw.pw_uid or st.st_gid != pw.pw_gid:
        os.lchown(home, pw.pw_uid, pw.pw_gid)
    os.chmod(home, 0o700)
    return pw


def unit_argv(r, unit):
    home = team_dir(r["tenantId"])
    props = [
        "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=", "ProtectSystem=strict",
        "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes",
        "ProtectHostname=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes", "RestrictRealtime=yes",
        "ProtectProc=invisible", "UMask=0077", f"TemporaryFileSystem={CONF['teams_root']}:ro",
        f"BindPaths={home}", f"ReadWritePaths={home}", f"WorkingDirectory={home}",
        f"MemoryMax={CONF['memory_max']}", f"CPUQuota={CONF['cpu_quota']}", f"TasksMax={CONF['tasks_max']}",
        f"RuntimeMaxSec={r['timeoutSec']}", "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=10",
    ] + [f"InaccessiblePaths=-{p}" for p in INACCESSIBLE]
    argv = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec", f"--unit={unit}",
            f"--uid={run_user(r['tenantId'])}", f"--gid={run_user(r['tenantId'])}"]
    for p in props:
        argv += ["-p", p]
    return argv + ["--", "/usr/bin/python3", "-I", CONF["stage"]]


def stage_spec(r):
    bin_ = ENGINES[r["engine"]]
    cmd = "/usr/bin/git" if bin_ is None else os.path.join(CONF["tools_bin"], bin_)
    home = team_dir(r["tenantId"])
    env = {"PATH": f"{CONF['tools_bin']}:/usr/local/bin:/usr/bin:/bin", "HOME": home, "USER": run_user(r["tenantId"]),
           "LANG": "C.UTF-8", "SHELL": "/bin/bash", "TMPDIR": "/tmp", **r["env"]}
    return {"cmd": cmd, "args": r["args"], "env": env, "workspace": r["workspace"], "mkdir": r["mkdir"],
            "files": r["files"], "readBack": r["readBack"], "rmAfter": r["rmAfter"]}


def peer_uid(conn):
    creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", creds)[1]


def read_request(conn):
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_REQ:
            raise Refused("request too large")
    return json.loads(buf.split(b"\n", 1)[0] or b"null")


def send(conn, obj, lock):
    data = (json.dumps(obj) + "\n").encode()
    with lock:
        conn.sendall(data)


def log(msg):
    print(msg, file=sys.stderr, flush=True)  # journal; never secrets: ids, engine, codes only


def handle(conn, client_uid):
    lock = threading.Lock()
    try:
        r = validate(read_request(conn), peer_uid(conn), client_uid)
        ensure_team(r["tenantId"])
    except Refused as e:
        log(f"refused: {e}")
        return send(conn, {"t": "e", "error": str(e)}, lock)
    except Exception as e:
        log(f"error: {type(e).__name__}")
        return send(conn, {"t": "e", "error": "launcher error"}, lock)
    unit = f"cobra-run-{r['tenantId']}-{r['runId'][:60]}-{uuid.uuid4().hex[:8]}"
    log(f"start {unit} engine={r['engine']} timeout={r['timeoutSec']}s")
    p = subprocess.Popen(unit_argv(r, unit), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stopped = threading.Event()

    def stop():
        if not stopped.is_set():
            stopped.set()
            subprocess.run(["systemctl", "kill", "--signal=SIGKILL", unit], capture_output=True)
            subprocess.run(["systemctl", "stop", unit], capture_output=True)

    def pump_err():
        for chunk in iter(lambda: p.stderr.read1(65536), b""):
            try:
                send(conn, {"t": "o", "d": chunk.decode("utf-8", "replace")}, lock)
            except OSError:
                stop()

    def watch_client():  # EOF/any data from the client after the request = cancel
        try:
            conn.recv(1)
        except OSError:
            pass
        if p.poll() is None:
            stop()

    te = threading.Thread(target=pump_err, daemon=True)
    te.start()
    threading.Thread(target=watch_client, daemon=True).start()
    timer = threading.Timer(r["timeoutSec"] + 30, stop)  # backstop for RuntimeMaxSec
    timer.start()
    try:
        p.stdin.write(json.dumps(stage_spec(r)).encode())
        p.stdin.close()
    except OSError:
        stop()
    out = p.stdout.read()
    code = p.wait()
    timer.cancel()
    te.join(5)
    p.stdout.close(); p.stderr.close()
    try:
        files = json.loads(out or b"{}").get("files", {})
    except ValueError:
        files = {}
    log(f"end {unit} code={code}{' (stopped)' if stopped.is_set() else ''}")
    try:
        send(conn, {"t": "x", "code": code, "files": files}, lock)
    except OSError:
        pass


def main():
    client_uid = pwd.getpwnam(CONF["client_user"]).pw_uid
    path = CONF["socket"]
    if os.path.exists(path):
        os.unlink(path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    srv.bind(path)
    os.umask(old)
    os.chown(path, 0, grp.getgrnam(CONF["client_user"]).gr_gid)
    os.chmod(path, 0o660)
    srv.listen(64)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log(f"listening on {path}")
    while True:
        conn, _ = srv.accept()

        def serve(c=conn):
            with c:
                handle(c, client_uid)
        threading.Thread(target=serve, daemon=True).start()


if __name__ == "__main__":
    main()
