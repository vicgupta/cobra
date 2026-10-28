"""Launcher tests: python3 -m unittest launcher/test_launcher.py (no root, no systemd: the unit is faked)."""
import json, os, socket, sys, tempfile, threading, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import launcher as L

UID = os.getuid()
yes = lambda tid: tid in (1, 2)


def req(**kw):
    r = {"tenantId": 2, "runId": "run_abc", "engine": "codex", "args": ["exec", "hi"], "env": {"CODEX_API_KEY": "k"},
         "workspace": os.path.join(L.CONF["teams_root"], "2", "workspaces", "run_abc"), "timeoutSec": 60}
    r.update(kw)
    return r


class Validate(unittest.TestCase):
    def refused(self, r, uid=UID, msg=None):
        with self.assertRaises(L.Refused) as c:
            L.validate(r, uid, UID, yes)
        if msg:
            self.assertIn(msg, str(c.exception))

    def test_ok(self):
        r = L.validate(req(), UID, UID, yes)
        self.assertEqual(r["engine"], "codex")
        self.assertTrue(r["workspace"].endswith("/2/workspaces/run_abc"))

    def test_wrong_peer_uid(self):
        self.refused(req(), uid=UID + 1, msg="peer")

    def test_bad_tenant(self):
        for t in (0, -1, "2", 2.0, True, None, 10**12):
            self.refused(req(tenantId=t), msg="tenantId")
        self.refused(req(tenantId=3, workspace=os.path.join(L.CONF["teams_root"], "3", "workspaces", "run_abc")), msg="unknown tenant")

    def test_bad_run_id(self):
        for rid in ("../x", "a/b", "", "a b", "x" * 129, "a;rm"):
            self.refused(req(runId=rid))

    def test_path_traversal(self):
        root = L.CONF["teams_root"]
        for w in (f"{root}/1/workspaces/run_abc", f"{root}/2/workspaces/run_abc/../../../1/workspaces/run_abc",
                  f"{root}/2/workspaces/../workspaces/run_abc", "/home/cobra", f"{root}/2", f"{root}/2/workspaces/other", None):
            self.refused(req(workspace=w), msg="workspace")
        for p in ("../x", "/etc/passwd", "a/../../b", ""):
            self.refused(req(files=[{"path": p, "content": "x"}]), msg="files")
            self.refused(req(readBack=[p]), msg="readBack")
            self.refused(req(rmAfter=[p]), msg="rmAfter")

    def test_disallowed_engine(self):
        for e in ("bash", "sh", "opencode", "", None, "/usr/bin/git"):
            self.refused(req(engine=e), msg="engine")

    def test_env_not_allowlisted(self):
        for k in ("PATH", "LD_PRELOAD", "HOME", "NODE_OPTIONS", "COBRA_SECRET_KEY", "BASH_ENV"):
            self.refused(req(env={k: "x"}), msg="env not allowed")
        self.refused(req(env={"GIT_CONFIG_KEY_0": "core.sshCommand"}), msg="git config")
        self.refused(req(env={"CODEX_HOME": "/home/cobra/.codex"}), msg="CODEX_HOME")
        self.refused(req(env={"GH_TOKEN": 5}), msg="bad env")

    def test_bad_args_and_timeout(self):
        self.refused(req(args="exec"), msg="args")
        self.refused(req(args=["a\0b"]), msg="args")
        for t in (0, -5, "60", 10**7, True):
            self.refused(req(timeoutSec=t), msg="timeoutSec")


class Unit(unittest.TestCase):
    def test_hardening_and_no_secrets_in_argv(self):
        r = L.validate(req(env={"CODEX_API_KEY": "sekrit-token"}, args=["exec", "secret prompt"]), UID, UID, yes)
        argv = L.unit_argv(r, "u1")
        s = " ".join(argv)
        for p in ("--uid=cobra-run-2", "NoNewPrivileges=yes", "CapabilityBoundingSet=", "ProtectSystem=strict", "PrivateTmp=yes",
                  "ProtectHome=yes", "InaccessiblePaths=-/etc/cobra", "InaccessiblePaths=-/var/lib/cobra", "InaccessiblePaths=-/home/cobra",
                  "RuntimeMaxSec=60", "MemoryMax=", "CPUQuota=", "TasksMax=", f"ReadWritePaths={L.CONF['teams_root']}/2",
                  f"TemporaryFileSystem={L.CONF['teams_root']}:ro"):
            self.assertIn(p, s)
        self.assertNotIn("sekrit-token", s)
        self.assertNotIn("secret prompt", s)
        spec = L.stage_spec(r)
        self.assertEqual(spec["cmd"], os.path.join(L.CONF["tools_bin"], "codex"))
        self.assertEqual(spec["env"]["HOME"], f"{L.CONF['teams_root']}/2")
        self.assertEqual(L.stage_spec({**r, "engine": "git"})["cmd"], "/usr/bin/git")


class Flow(unittest.TestCase):
    """handle() end to end over a socketpair, with the transient unit replaced by running stage.py directly."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = (L.CONF["teams_root"], L.unit_argv, L.ensure_team, L.tenant_exists)
        L.CONF["teams_root"] = self.tmp
        stage = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stage.py")
        L.unit_argv = lambda r, unit: [sys.executable, stage]
        L.ensure_team = lambda tid: os.makedirs(L.team_dir(tid), exist_ok=True)
        L.validate.__defaults__ = (yes,)

    def tearDown(self):
        L.CONF["teams_root"], L.unit_argv, L.ensure_team, L.tenant_exists = self.saved
        L.validate.__defaults__ = (L.tenant_exists,)

    def call(self, r, client_uid=UID):
        a, b = socket.socketpair()
        t = threading.Thread(target=lambda: (L.handle(b, client_uid), b.close()))
        t.start()
        a.sendall((json.dumps(r) + "\n").encode())
        frames, buf = [], b""
        while True:
            c = a.recv(65536)
            if not c:
                break
            buf += c
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                frames.append(json.loads(line))
                if frames[-1]["t"] in ("x", "e"):
                    a.close(); t.join(10); return frames
        a.close(); t.join(10)
        return frames

    def test_git_runs_streams_and_reads_back(self):
        ws = os.path.join(self.tmp, "2", "workspaces", "run_abc")
        fr = self.call(req(engine="git", args=["init", "-q"], env={}, workspace=ws, mkdir=True,
                           files=[{"path": ".cobra/SOP.md", "content": "sop"}], readBack=[".cobra/SOP.md", "missing"], rmAfter=[".cobra"]))
        self.assertEqual(fr[-1]["t"], "x", fr)
        self.assertEqual(fr[-1]["code"], 0)
        self.assertEqual(fr[-1]["files"], {".cobra/SOP.md": "sop", "missing": None})
        self.assertTrue(os.path.isdir(os.path.join(ws, ".git")))
        self.assertFalse(os.path.exists(os.path.join(ws, ".cobra")))
        fr = self.call(req(engine="git", args=["status", "--bogus"], env={}, workspace=ws))
        self.assertNotEqual(fr[-1]["code"], 0)
        self.assertIn("bogus", "".join(f.get("d", "") for f in fr))

    def test_refusals_over_socket(self):
        self.assertEqual(self.call(req(), client_uid=UID + 1)[-1], {"t": "e", "error": "peer not allowed"})
        self.assertEqual(self.call(req(engine="bash"))[-1]["error"], "engine not allowed")
        self.assertEqual(self.call(req(env={"LD_PRELOAD": "x"}))[-1]["error"], "env not allowed: LD_PRELOAD")


if __name__ == "__main__":
    unittest.main()
