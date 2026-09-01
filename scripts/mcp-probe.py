#!/usr/bin/env python3
"""Minimal MCP stdio probe: initialize + tools/list, then close cleanly."""
import json, subprocess, sys, threading, time

cmd = sys.argv[1:]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
out = {}
def reader():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get("id") in (1, 2):
            out[m["id"]] = m
t = threading.Thread(target=reader, daemon=True); t.start()

def send(o):
    p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05","capabilities":{},
    "clientInfo":{"name":"probe","version":"1"}}})
deadline = time.time() + 90
while 1 not in out and time.time() < deadline:
    time.sleep(0.2)
if 1 in out:
    print("  initialize OK:", out[1].get("result", {}).get("serverInfo"))
    send({"jsonrpc":"2.0","method":"notifications/initialized"})
    send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    deadline = time.time() + 60
    while 2 not in out and time.time() < deadline:
        time.sleep(0.2)
    if 2 in out:
        ts = out[2].get("result", {}).get("tools", [])
        print(f"  tools/list OK: {len(ts)} tool, pl.: {[x['name'] for x in ts[:6]]}")
    else:
        print("  tools/list: NINCS VALASZ")
else:
    print("  initialize: NINCS VALASZ")
try:
    p.stdin.close(); p.wait(timeout=10)
except Exception:
    p.kill()
