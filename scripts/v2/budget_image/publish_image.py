#!/usr/bin/env python3
"""Publish report.png to a public raw-GitHub URL so Whapi can fetch it.

Whapi pulls media server-side, so the file must be publicly reachable; the repo
is public, which makes a dedicated single-commit branch the cheapest host — no
Vercel deploy, so it can't race the roas-live deploys that other workflows do.

Uses git plumbing (hash-object / commit-tree) against a temporary index, so the
working tree and the current branch are never touched.
"""
import argparse, os, pathlib, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
BRANCH = "report-images"
FILENAME = "budget_report.png"
RAW = "https://raw.githubusercontent.com/pulkit1165/meta-ads-reports2/{branch}/{name}"


def git(*args, **kw):
    env = {**os.environ, **kw.pop("env", {})}
    p = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, env=env, **kw)
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {p.stderr.strip()[:300]}")
    return p.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", default=str(HERE / "report.png"))
    ap.add_argument("--message", default="budget report image")
    a = ap.parse_args()

    png = pathlib.Path(a.png)
    if not png.exists():
        sys.exit(f"missing {png}")

    blob = git("hash-object", "-w", str(png))
    with tempfile.TemporaryDirectory() as tmp:
        idx = str(pathlib.Path(tmp) / "index")
        env = {"GIT_INDEX_FILE": idx}
        git("read-tree", "--empty", env=env)
        git("update-index", "--add", "--cacheinfo", f"100644,{blob},{FILENAME}", env=env)
        tree = git("write-tree", env=env)
    # single-commit branch: no history, so the branch never grows
    commit = git("commit-tree", tree, "-m", a.message)
    git("update-ref", f"refs/heads/{BRANCH}", commit)
    git("push", "--force", "origin", f"{BRANCH}:{BRANCH}")

    url = RAW.format(branch=BRANCH, name=FILENAME)
    print(url)
    return url


if __name__ == "__main__":
    main()
