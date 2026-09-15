#!/usr/bin/env python3
"""
usage-quota-gate.py -- weekly Max-quota EMERGENCY GATE (card 6d9de12c, 2026-09-14).

Runs right after scripts/usage-collect.py (same command task, usage-collect-hourly).
Reads store/usage-latest.json (never calls the provider itself), and when the
Claude seven_day window's used_percent reaches a threshold (80, then 90) it
sends ONCE per threshold per window:
  - an inter-agent message to the main agent, prefixed [KVOTA], via the
    dashboard API (bearer from store/.dashboard-token). The API accepts only
    registered agent ids as `from`, so the note is sent from the main agent
    to itself -- the same self-note shape the level-1 FELHIVAS rule uses; and
  - a Telegram message to the owner chat via the Bot API (token from .env).
The fired-state lives in store/usage-alert-state.json under its own keys
(claude_seven_day_threshold_<N>), keyed by the window's resets_at: when the
window resets (resets_at changes), the thresholds arm again. Read + message
only -- nothing is stopped here; the soft-stop belongs to card 5715dad4.

Never prints or logs token values. Exit code is always 0 (a monitor must not
break the scheduler), except in --self-test, which exits 1 on a failed check.

Usage:
  usage-quota-gate.py                       # real run (after usage-collect)
  usage-quota-gate.py --dry-run             # decide + print, send nothing
  usage-quota-gate.py --snapshot F --state G [--dry-run]   # test seams
  usage-quota-gate.py --self-test           # both directions + reset, offline
"""
import argparse
import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "store")
SNAPSHOT_PATH = os.path.join(STORE, "usage-latest.json")
STATE_PATH = os.path.join(STORE, "usage-alert-state.json")
THRESHOLDS = (80, 90)
WINDOW = "seven_day"
OWNER_CHAT_ID = "7544590867"
API = "http://127.0.0.1:3420"


def read_env_value(name):
    """Value of NAME= from .env (or the process env), without ever printing it."""
    v = os.environ.get(name)
    if v:
        return v
    try:
        with open(os.path.join(ROOT, ".env"), "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def fmt_reset(resets_at):
    try:
        dt = datetime.fromtimestamp(float(resets_at), tz=timezone.utc).astimezone()
        return dt.strftime("%a %m-%d %H:%M")
    except (TypeError, ValueError, OSError):
        return "ismeretlen"


def decide(snapshot, state, thresholds=THRESHOLDS, window=WINDOW):
    """Pure. Returns (to_fire: list[int], new_state). A threshold fires when
    used_percent >= threshold AND it has not fired for this resets_at yet.
    A changed resets_at (window rolled over) re-arms every threshold."""
    w = (((snapshot or {}).get("claude") or {}).get("windows") or {}).get(window) or {}
    used = w.get("used_percent")
    resets_at = w.get("resets_at")
    new_state = dict(state or {})
    to_fire = []
    if used is None:
        return to_fire, new_state
    for t in thresholds:
        key = f"claude_{window}_threshold_{t}"
        entry = dict(new_state.get(key) or {})
        if entry.get("fired_for_reset") not in (None, resets_at):
            entry = {}  # the window reset since the last firing -> re-arm
        if float(used) >= t and entry.get("fired_for_reset") != resets_at:
            to_fire.append(t)
            entry = {"fired_for_reset": resets_at, "fired_at": datetime.now(timezone.utc).isoformat(), "used_percent": used}
        new_state[key] = entry
    return to_fire, new_state


def message_text(t, snapshot):
    w = snapshot["claude"]["windows"]
    sd = w.get(WINDOW, {})
    fh = w.get("five_hour", {})
    op = w.get("seven_day_opus", {})
    return (
        f"[KVOTA] Heti Max-keret {sd.get('used_percent')}% (kuszob {t}%). "
        f"Reset: {fmt_reset(sd.get('resets_at'))}. 5 oras: {fh.get('used_percent')}%, Fable-heti: {op.get('used_percent')}%. "
        + ("Atallasi szabaly 80%: aura, zeph, irisz, stratega, nyomozo, lumen, Kenshin, marveen -> Sonnet 5 (a Fable nem kulon keret). Visszaallas a reset utan." if t < 90
           else "90%: nem surgos feladatok szuneteltetese a resetig. Visszaallas a reset utan.")
    )


def send_inter_agent(text):
    token_path = os.path.join(STORE, ".dashboard-token")
    with open(token_path, "r", encoding="utf-8") as f:
        token = f.read().strip()
    main_agent = read_env_value("MAIN_AGENT_ID") or "marveen"
    body = json.dumps({"from": main_agent, "to": main_agent, "content": text}).encode("utf-8")
    req = urllib.request.Request(f"{API}/api/messages", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def send_telegram(text):
    bot = read_env_value("TELEGRAM_BOT_TOKEN")
    if not bot:
        return "no-token"
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    body = json.dumps({"chat_id": OWNER_CHAT_ID, "text": text, "disable_web_page_preview": True}).encode("utf-8")
    req = urllib.request.Request(f"{base}/bot{bot}/sendMessage", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status


def self_test():
    ok = True

    def check(cond, label):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + label)
        ok = ok and cond

    snap = lambda used, reset: {"claude": {"windows": {"seven_day": {"used_percent": used, "resets_at": reset}, "five_hour": {"used_percent": 10}, "seven_day_opus": {"used_percent": 20}}}}
    r1 = 1789650000.0
    # allowed direction: below every threshold nothing fires, state stays armed
    f, s = decide(snap(55, r1), {})
    check(f == [], "55%: nothing fires")
    # 80 crossed: fires 80 once, not 90
    f, s = decide(snap(81, r1), s)
    check(f == [80], "81%: fires 80 only")
    f, s = decide(snap(85, r1), s)
    check(f == [], "85% again: 80 does not repeat")
    # 90 crossed: fires 90 once
    f, s = decide(snap(90, r1), s)
    check(f == [90], "90%: fires 90 only")
    f, s = decide(snap(97, r1), s)
    check(f == [], "97%: neither repeats")
    # window reset: resets_at changes -> re-armed, high usage fires both again
    f, s = decide(snap(92, r1 + 7 * 86400), s)
    check(sorted(f) == [80, 90], "after reset at 92%: both fire again")
    # reset with low usage: re-armed but silent
    f, s = decide(snap(30, r1 + 14 * 86400), s)
    check(f == [] and s["claude_seven_day_threshold_80"] == {}, "after reset at 30%: silent and re-armed")
    # missing data never fires and never crashes
    f, s = decide({}, s)
    check(f == [], "empty snapshot: nothing")
    # message text has no em dash (outgoing copy rule) and carries the reset
    m = message_text(80, snap(81, r1))
    check("—" not in m and "[KVOTA]" in m and "Reset:" in m, "message text: [KVOTA] prefix, reset, no em dash")
    # foreign keys in the shared state file survive
    f, s = decide(snap(55, r1), {"claude_five_hour_over": {"active": False}})
    check(s.get("claude_five_hour_over") == {"active": False}, "usage-collect's own state keys are preserved")
    print("self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", default=SNAPSHOT_PATH)
    ap.add_argument("--state", default=STATE_PATH)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test())
    snapshot = load_json(a.snapshot, {})
    state = load_json(a.state, {})
    to_fire, new_state = decide(snapshot, state)
    w = (((snapshot.get("claude") or {}).get("windows") or {}).get(WINDOW) or {})
    print(f"usage-quota-gate: seven_day={w.get('used_percent')}% reset={fmt_reset(w.get('resets_at'))} fire={to_fire or 'none'}{' (dry-run)' if a.dry_run else ''}")
    for t in to_fire:
        text = message_text(t, snapshot)
        if a.dry_run:
            print("  would send:", text)
            continue
        try:
            print("  inter-agent:", send_inter_agent(text))
        except Exception as e:  # never crash the scheduler
            print("  inter-agent FAILED:", type(e).__name__)
        try:
            print("  telegram:", send_telegram(text))
        except Exception as e:
            print("  telegram FAILED:", type(e).__name__)
    if not a.dry_run:
        save_state(a.state, new_state)


if __name__ == "__main__":
    main()
