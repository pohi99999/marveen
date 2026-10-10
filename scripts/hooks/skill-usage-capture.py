#!/usr/bin/env python3
"""PostToolUse hook: log skill usage to the persistent skill_usage table.

Two event types are captured:
  tool_call  -- the Skill tool was invoked (tool_name == 'Skill')
  skill_read -- a SKILL.md file under <anywhere>/.claude/skills/<name>/SKILL.md was read, either with
                the Read tool or, since 2026-10-10, from Bash (cat/sed/head/grep/python ... with the
                path in the command)

Unlike tool_call_log (pruned every 24 h), skill_usage is never pruned so the
dream-engine can make data-driven suggestions after two or more weeks of data.

Registration (user-level ~/.claude/settings.json, post-install step):
  The hook command uses a guard so it silently no-ops if the file is missing
  (e.g. on develop before merging this feature):

    "command": "test -f /path/to/scripts/hooks/skill-usage-capture.py && python3 ... || true"

  This means the hook can be registered before merge without causing errors
  on other branches where the file does not yet exist.
"""
import sys
import os
import re
import json
import shlex
# urllib.request is imported lazily in _post(): it costs ~25 ms of the hook's ~45 ms, and since the
# hook also runs on EVERY Bash call (2026-10-10), the common no-match case must stay cheap.

# Agent identity comes from the ledger library -- ONE resolver for every hook.
# This file used to carry its own _agent_id_from_cwd() copy, which drifted:
# it missed the install-subdirectory case (only `cwd == install` mapped to the
# main agent) and kept the basename fallback, so skill_usage rows got an agent
# id INVENTED from the directory name. A drifted private copy is exactly how
# that class of bug survives -- delegate instead of duplicating.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _install_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


# Kept as a module-level alias for the tests (they pin that this file has no
# private copy of the resolver); the hook itself resolves from the PAYLOAD
# (transcript-anchored, LEDGERCWD828), not from this cwd-only fallback.
_agent_id_from_cwd = ledger_lib.agent_id_from_cwd


# <barhol>/.claude/skills/<name>/SKILL.md
#
# 2026-09-14: a minta KORABBAN csak a futo
# felhasznalo HOME-ja ala illeszkedett (`~/.claude/skills/...`). Emiatt a
# PROJEKT-SZINTU skillek (pl. <install>/.claude/skills/<nev>/SKILL.md) olvasasa
# SOHA nem keletkeztetett skill_usage sort -- a dream-engine 5. bucketje pedig
# epp az "utolso hasznalat" alapjan javasolna avult skilleket, tehat vakon futott.
# Merve 2026-09-14: 71 telepitett skillhez OSSZESEN 4 usage-sor tartozott, es
# mind a negy `tool_call` volt, egyetlen `skill_read` sem.
#
# 2026-10-10 (Zeph 3261, Marveen 3263): a Bash-bol olvasott SKILL.md is skill_read sort ad
# (_classify_bash). Elotte a hook csak a Read TOOL-t latta, es a dream-engine "nem hasznalt skill"
# kovetkeztetese meresi resen allt (pl. a gws-skillek, amiket cat/sed-del olvasnak).
# MEGMARADO KORLAT, kimondva: amit nem a parancssorban nevez meg az ugynok (pl. egy valtozoban
# tarolt ut, egy szkriptfajl, ami belul olvas, Grep/Glob tool), az tovabbra sem ad sort. A "0
# hasznalat" ezert most is csak jelzes, nem bizonyitek arra, hogy a skill halott.
_SKILL_MD_RE = re.compile(r"(?:^|/)\.claude/skills/([^/]+)/SKILL\.md$")


# A Bash parancsban: a SKILL.md utja barmilyen elotaggal (abszolut, relativ, $HOME/...), a skill neve
# csak "biztonsagos" karakterekbol allhat -- egy glob (`.claude/skills/*/SKILL.md`) NEM egy skill
# olvasasa, hanem mindegyike, es ilyenkor nem tudjuk, melyiket hasznalta.
_BASH_SKILL_RE = re.compile(
    r"(?:^|[\s'\"=(<:])(?:[^\s'\"=(<>|;&]*/)?\.claude/skills/([A-Za-z0-9][A-Za-z0-9._-]*)/SKILL\.md(?![A-Za-z0-9._/-])"
)
# Parancsok, amelyek egy fajl TARTALMAT olvassak. Ami nincs itt (ls, git, cp, mv, rm, stat, test,
# echo ...), az nem hasznalat.
_READERS = frozenset({
    "cat", "bat", "batcat", "less", "more", "head", "tail", "sed", "awk", "gawk", "grep", "egrep",
    "fgrep", "rg", "ugrep", "nl", "python", "python3", "node", "jq", "view", "vim", "nvim", "nano",
})
# Interpreterek: a fajlutat a kodjukban (-c, heredoc) is keressuk, nem csak az argumentumokban.
_INTERPRETERS = frozenset({"python", "python3", "node"})
_MAX_SKILLS_PER_COMMAND = 5


def _segment_command(seg: str) -> tuple[str, list[str]]:
    """First real command word of a pipeline segment (skipping VAR=x, sudo, env, timeout N)."""
    try:
        words = shlex.split(seg, posix=True)
    except ValueError:
        words = seg.split()
    i = 0
    while i < len(words):
        w = words[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) or w in ("sudo", "env", "command", "exec", "nice"):
            i += 1
            continue
        if w == "timeout":
            i += 2
            continue
        break
    if i >= len(words):
        return "", []
    return os.path.basename(words[i]), words[i + 1:]


def _classify_bash(command: str) -> list[tuple[str, str]]:
    """skill_read rows for every SKILL.md a Bash command reads (cat/sed/head/grep/python ...)."""
    if ".claude/skills/" not in command or "SKILL.md" not in command:
        return []  # the common case: no work, no imports
    segments = [s for s in re.split(r"\|\||&&|[|;\n]", command)]
    found: list[str] = []

    def add(name: str) -> None:
        if name not in found and len(found) < _MAX_SKILLS_PER_COMMAND:
            found.append(name)

    interpreter_seen = False
    for seg in segments:
        cmd, args = _segment_command(seg)
        if cmd in _INTERPRETERS:
            interpreter_seen = True
        if cmd not in _READERS:
            continue
        if cmd == "sed" and any(a == "-i" or (a.startswith("-i") and not a.startswith("--")) or a.startswith("--in-place") for a in args):
            continue  # an in-place edit is maintenance, not use
        for m in _BASH_SKILL_RE.finditer(seg):
            if seg[: m.start()].rstrip().endswith(">"):
                continue  # the SKILL.md is a redirect TARGET: a write, not a read
            add(m.group(1))
    if interpreter_seen:
        # python3 -c "open('.../SKILL.md')" or a heredoc: the path sits in the code, which the
        # segment split above cut into pieces (newlines). Scan the whole command once.
        for m in _BASH_SKILL_RE.finditer(command):
            if command[: m.start()].rstrip().endswith(">"):
                continue
            add(m.group(1))
    return [(name, "skill_read") for name in found]


def _classify_all(tool_name: str, tool_input: dict) -> list[tuple[str, str]]:
    """Every (skill_name, trigger_type) row one tool call produces."""
    if tool_name == "Bash":
        return _classify_bash(str(tool_input.get("command") or ""))
    one = _classify(tool_name, tool_input)
    return [one] if one else []


def _classify(tool_name: str, tool_input: dict) -> tuple[str, str] | None:
    """Return (skill_name, trigger_type) or None if this event is irrelevant."""
    if tool_name == "Skill":
        skill = (tool_input.get("skill") or "").strip()
        if skill:
            return skill, "tool_call"
    elif tool_name == "Read":
        path = (tool_input.get("file_path") or "").strip()
        # search(), NEM match(): a minta mostantol a path BARMELY pontjan illeszkedhet
        # (projekt-szintu skillek utja nem a home-mal kezdodik). A match() a 0. poziciohoz
        # kotne, es epp a projekt-szintu eseteket dobna el -- azt, amiert a mintat bovitettuk.
        m = _SKILL_MD_RE.search(path)
        if m:
            return m.group(1), "skill_read"
    return None


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    session_id = payload.get("session_id") or None
    cwd = payload.get("cwd") or ""

    rows = _classify_all(tool_name, tool_input)
    if not rows:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_payload(payload)

    token = _dashboard_token()
    if not token:
        sys.exit(0)

    import urllib.request  # lazy: see the import block at the top

    for skill_name, trigger_type in rows:
        body = json.dumps({
            "agent_id": agent_id,
            "skill_name": skill_name,
            "trigger_type": trigger_type,
            "session_id": session_id,
        }).encode()
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    f"http://localhost:{_web_port()}/api/skill-usage",
                    data=body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {token}",
                    },
                    method="POST",
                ),
                timeout=3,
            )
        except Exception:
            pass  # never block the agent

    sys.exit(0)


if __name__ == "__main__":
    main()
