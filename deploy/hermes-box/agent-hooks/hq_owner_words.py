#!/usr/bin/env python3
"""HeyZubi rule (Murtaza, 2026-11-23, from Theo): a run that didn't start from the owner's own words can look
things up and draft, but never send, share, post, publish or delete.

Hermes runs this before tool calls (a pre_tool_call shell hook, see config.yaml `hooks:`). It refuses an
outward action when the session is
  - a scheduled job (Hermes cron), or a helper started inside one, or
  - a HeyZubi chat turn that HeyZubi marked as not the owner's words (a routine, another bot, a system
    notice, an outside program): HeyZubi writes $HERMES_HOME/hq-guard/<conversation>.json while such a turn runs.
Coding runs (owner-started pull-request jobs) get a marker of kind "coding": they may commit to their own
branch and open a pull request, but never merge, force-push, push or write to the base branch, delete, or
send anything.
Anything else (the owner's messages on HeyZubi, Zubi HQ, Telegram, voice) passes untouched.
Stdlib only. Any error lets the call through (Hermes hooks fail open), so it can never stop the owner's work.
"""
import json
import os
import re
import sqlite3
import sys
import time

HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
GUARD = os.path.join(HOME, "hq-guard")
# Words in a tool or app-action name (whole _-separated parts) that mean it acts outward.
STRONG = {"SEND", "DELETE", "TRASH", "PUBLISH", "FORWARD", "TRANSFER", "PAY", "BROADCAST", "TWEET", "RETWEET", "MERGE"}
WEAK = {"POST", "SHARE", "REPLY", "COMMENT", "UPLOAD", "INVITE", "REMOVE", "DM", "PULL", "PUSH", "COMMIT"}  # outward unless it only reads
READ = {"GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "COUNT", "VIEW", "LOOKUP"}
# Tools that can run anything in connected apps: outward when the run isn't the owner's.
OPEN_ENDED = re.compile(r"COMPOSIO_(REMOTE_WORKBENCH|REMOTE_BASH_TOOL|PROXY_EXECUTE)", re.I)
# Shell commands that publish code (found in the terminal tool's command text).
SHELL_OUT = re.compile(r"\b(git\s+push|gh\s+pr\s+(create|merge)|gh\s+api|gh\s+release\s+create)\b")
# GitHub app actions that write to a repository.
REPO_WRITE = {"CREATE", "UPDATE", "COMMIT", "PUSH", "MERGE", "DELETE", "UPSERT", "PUT"}
FILE_WRITE = {"FILE", "FILES", "CONTENTS", "COMMIT"}


def names(tool, args):
    out = [tool or ""]
    if isinstance(args, dict):
        for t in args.get("tools") or []:  # Composio's batch: [{tool_slug, arguments}]
            if isinstance(t, dict):
                out.append(str(t.get("tool_slug") or t.get("slug") or ""))
        for k in ("tool_slug", "slug"):
            if isinstance(args.get(k), str):
                out.append(args[k])
    return [n for n in out if n]


def parts(n):
    return set(p for p in re.split(r"[^A-Z]+", n.upper()) if p)


def arg_dicts(args):
    """The tool's arguments and, for Composio's batch, each action's arguments."""
    out = [args] if isinstance(args, dict) else []
    if isinstance(args, dict):
        for t in args.get("tools") or []:
            if isinstance(t, dict) and isinstance(t.get("arguments"), dict):
                out.append(t["arguments"])
    return out


def shell_text(args):
    return "\n".join(v for d in arg_dicts(args) for v in d.values() if isinstance(v, str))


def outward(tool, args):
    for n in names(tool, args):
        if OPEN_ENDED.search(n):
            return n
        p = parts(n)
        if p & STRONG or (p & WEAK and not p & READ):
            return n
    m = SHELL_OUT.search(shell_text(args))
    return m.group(0) if m else None


def github_write(tool, args):
    return any("GITHUB" in p and p & REPO_WRITE and not p & READ for p in map(parts, names(tool, args)))


def coding_refusal(tool, args, base):
    """What a coding run may not do (None when the call is fine)."""
    sh = shell_text(args)
    b = re.escape(base)
    if re.search(r"\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*/merges?\b", sh):
        return "merge a pull request"
    for m in re.finditer(r"\bgit\s+push\b[^\n;&|]*", sh):
        cmd = m.group(0)
        if re.search(r"--force|--mirror|--delete|\s-[a-zA-Z]*[fd]\b|\s\+\S|\s:\S", cmd):
            return "force-push or delete a branch"
        if re.search(r"(?<![\w./-])" + b + r"(?![\w./-])|refs/heads/" + b + r"(?![\w./-])", cmd):
            return f"push to {base}"
    for n in names(tool, args):
        p = parts(n)
        if "MERGE" in p:
            return "merge"
        if p & {"DELETE", "TRASH", "REMOVE"}:
            return "delete anything"
        if "GITHUB" not in p and (OPEN_ENDED.search(n) is None) and (p & STRONG or (p & WEAK and not p & READ)):
            return "send, post or share anything besides the pull request"
        if "GITHUB" in p and p & REPO_WRITE and not p & READ:
            for d in arg_dicts(args):
                branch = next((d[k] for k in ("branch", "ref", "target_branch") if isinstance(d.get(k), str) and d.get(k)), None)
                if branch is not None and re.sub(r"^(refs/)?(heads/)?", "", branch) == base:
                    return f"write to {base}"
                # A file write without a branch lands on the default branch.
                if branch is None and p & FILE_WRITE and ("path" in d or "files" in d or "message" in d):
                    return "commit without naming the run's own branch"
    return None


def ro(name):
    return sqlite3.connect(f"file:{os.path.join(HOME, name)}?mode=ro", uri=True, timeout=2)


def session_chain(sid):
    """The session and its parents (helpers inherit their parent's origin): [(id, source, started)]."""
    out = []
    with ro("state.db") as db:
        for _ in range(4):
            r = db.execute("SELECT id, source, started_at, parent_session_id FROM sessions WHERE id=?", (sid,)).fetchone()
            if not r:
                break
            out.append((r[0], r[1] or "", r[2] or 0))
            if not r[3]:
                break
            sid = r[3]
    return out


def heyzubi_marker(chain):
    """The HeyZubi marker that covers one of these sessions (a not-owner turn or a coding run), if any."""
    try:
        marks = []
        now = time.time() * 1000
        for f in os.listdir(GUARD):
            if f.endswith(".json"):
                try:
                    m = json.load(open(os.path.join(GUARD, f), encoding="utf-8"))
                    if m.get("until", 0) > now:
                        marks.append(m)
                except Exception:
                    pass
        if not marks:
            return None
        ids = {c[0] for c in chain}
        fallback = None
        with ro("response_store.db") as rs:
            for m in marks:
                # The main team member's one session, named by HeyZubi: also when this conversation has no stored response.
                if m.get("session") in ids:
                    return m
                row = rs.execute(
                    "SELECT json_extract(r.data, '$.session_id') FROM conversations c JOIN responses r ON r.response_id = c.response_id WHERE c.name = ?",
                    (m.get("conversation", ""),)).fetchone()
                if row and row[0] in ids:
                    return m
                # A brand-new conversation has no stored response yet: a server session that began during the
                # marked turn (a coding run's session begins within a minute of its marker).
                since = m.get("since", 0)
                late = since + 60_000 if m.get("kind") == "coding" else float("inf")
                if not row and fallback is None and any(c[1] == "api_server" and since - 5000 <= c[2] * 1000 <= late for c in chain):
                    fallback = m
        return fallback
    except FileNotFoundError:
        return None


def block(message, why, tool):
    try:
        os.makedirs(GUARD, exist_ok=True)
        with open(os.path.join(GUARD, "blocked.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": int(time.time() * 1000), "why": why, "tool": (tool or "")[:120]}) + "\n")
    except Exception:
        pass
    print(json.dumps({"action": "block", "message": message}))


def main():
    data = json.load(sys.stdin)
    if data.get("hook_event_name") != "pre_tool_call":
        return
    tool, args = data.get("tool_name") or "", data.get("tool_input") or {}
    hit = outward(tool, args)
    if not hit and not github_write(tool, args):
        return
    chain = session_chain(data.get("session_id") or "")
    if hit and any(c[1] == "cron" for c in chain):
        why = "a scheduled job"
    else:
        m = heyzubi_marker(chain)
        if not m:
            return
        if m.get("kind") == "coding":
            no = coding_refusal(tool, args, m.get("base") or "main")
            if no:
                block(f"Not done: a coding run may not {no}. Commit only to the run's own branch ({m.get('branch', 'its branch')}) "
                      f"and open a pull request into {m.get('base', 'main')}; Murtaza reviews and merges.", f"coding run: {no}", tool)
            return
        if not hit:
            return
        why = m.get("why") or "a run that wasn't the owner's own words"
        # HeyZubi's own guards (the owner blocked actions, the circuit breaker, outside content) say why themselves.
        if str(m.get("kind", "")).startswith("guard-") and isinstance(m.get("message"), str) and m["message"].strip():
            block(f"{m['message'].strip()} ({hit})", why, hit)
            return
    block(f"Not done: this run started from {why}, not from Murtaza's own words, so it can't send, share, post, "
          f"publish or delete anything ({hit}). Prepare it as a draft instead and tell him it's ready for his OK.", why, hit)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open: never stop a call because the check itself broke
