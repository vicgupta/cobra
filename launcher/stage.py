#!/usr/bin/python3
"""Runs inside the transient unit as the team user: reads the step spec (JSON) on stdin, creates the workspace
and pre-run files, runs the command with its stdout+stderr on fd 2 (streamed by the launcher), then prints
{"files": {...}} (read-back files) on stdout and removes rmAfter paths. Exit code = the command's."""
import json, os, shutil, subprocess, sys


def main():
    spec = json.loads(sys.stdin.read())
    ws = spec["workspace"]
    if spec.get("mkdir"):
        os.makedirs(ws, mode=0o700, exist_ok=True)
    os.chdir(ws)
    for f in spec.get("files", []):
        os.makedirs(os.path.dirname(f["path"]) or ".", mode=0o700, exist_ok=True)
        with open(f["path"], "a" if f.get("append") else "w") as fh:
            fh.write(f["content"])
        if f.get("mode"):
            os.chmod(f["path"], int(f["mode"], 8) & 0o700)
    code = 127
    try:
        code = subprocess.run([spec["cmd"], *spec["args"]], env=spec["env"], stdin=subprocess.DEVNULL,
                              stdout=2, stderr=2).returncode
    except OSError as e:
        print(f"[cobra] cannot run {os.path.basename(spec['cmd'])}: {e.strerror}", file=sys.stderr)
    files = {}
    for p in spec.get("readBack", []):
        try:
            with open(p) as fh:
                files[p] = fh.read()
        except OSError:
            files[p] = None
    for p in spec.get("rmAfter", []):
        shutil.rmtree(p, ignore_errors=True)
    sys.stdout.write(json.dumps({"files": files}))
    sys.exit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()
