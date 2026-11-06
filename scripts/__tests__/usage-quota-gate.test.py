#!/usr/bin/env python3
"""QUOTA70EARLY1008 (card c394dc95): the weekly seven_day gate gets a 70% early warning.

Owner GO 2026-10-08 (Telegram 6787): at 70% of the weekly Max quota a [KVOTA] note goes out
once per window, but it only informs -- the switch rule (Sonnet) starts at 85 (owner, Telegram
10968, 2026-10-26; it was 80 from 2026-09-22).
This drives the real main() path (snapshot file -> decide -> sends -> state file) with the two
senders captured, so nothing reaches the dashboard or Telegram, and checks:
  - 69%: nothing is sent (the allowed direction);
  - 70%: exactly one message, to the main agent AND the owner, with the early-warning text and
    without the switch rule;
  - 75% in the same window: nothing (70 fires once);
  - 84% after that: still nothing (the old 80 line and anything under 85 stay silent);
  - 85%: the 85 message with the switch rule (an earlier 70 does not hold 85 back);
  - a jump from below 70 straight to 88% between two reads: only the 85 message is sent (the
    "no switch now" text would contradict it), yet 70 is recorded, so it does not come back at 89%;
  - the script's own --self-test still passes.

Run:  python3 scripts/__tests__/usage-quota-gate.test.py
"""
import importlib.util, io, json, os, subprocess, sys, tempfile
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'usage-quota-gate.py')
spec = importlib.util.spec_from_file_location('usage_quota_gate', SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

FAILS = []
def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)

SENT = []  # (channel, text)
gate.send_inter_agent = lambda text: SENT.append(('inter-agent', text)) or 200
gate.send_telegram = lambda text: SENT.append(('telegram', text)) or 200

TMP = tempfile.mkdtemp(prefix='quota-gate-test-')
SNAP = os.path.join(TMP, 'usage-latest.json')
STATE = os.path.join(TMP, 'usage-alert-state.json')
RESET = 1791900000.0  # a fixed window end

def run(used, state_reset=False, opus=10):
    if state_reset and os.path.exists(STATE):
        os.remove(STATE)
    with open(SNAP, 'w', encoding='utf-8') as f:
        json.dump({'claude': {'windows': {
            'seven_day': {'used_percent': used, 'resets_at': RESET},
            'five_hour': {'used_percent': 12},
            'seven_day_opus': {'used_percent': opus, 'resets_at': RESET}}}}, f)
    SENT.clear()
    sys.argv = ['usage-quota-gate.py', '--snapshot', SNAP, '--state', STATE]
    with redirect_stdout(io.StringIO()):
        gate.main()
    return list(SENT)

def state():
    with open(STATE, encoding='utf-8') as f:
        return json.load(f)

sent = run(69, state_reset=True)
check('69%: nothing is sent', sent == [], sent)
check('69%: 70 stays armed in the state file', not state().get('claude_seven_day_threshold_70', {}).get('fired_for_reset'))

sent = run(70)
check('70%: one message to the main agent and one to the owner', [c for c, _ in sent] == ['inter-agent', 'telegram'], sent)
text = sent[0][1] if sent else ''
check('70%: early-warning text', 'Korai jelzes' in text and '70%' in text and 'nincs atallas' in text, text)
check('70%: names the 85 switch line', 'atallasi hatar 85%' in text and 'hatar 80' not in text, text)
check('70%: no switch rule in the text', 'Sonnet' not in text and 'Atallasi szabaly' not in text, text)
check('70%: time to reset is named', ' van a resetig' in text, text)
check('70%: no em dash', '—' not in text, text)

sent = run(75)
check('75%, same window: 70 does not repeat', sent == [], sent)

sent = run(80)
check('80% after 70: nothing is sent (80 is no longer the switch line)', sent == [], sent)
sent = run(84)
check('84%: nothing is sent', sent == [], sent)

sent = run(85)
check('85% after 70: the 85 message goes out (70 does not hold it back)',
      len(sent) == 2 and 'kuszob 85%' in sent[0][1] and 'Atallasi szabaly 85%' in sent[0][1], sent)
check('85%: no early-warning text next to it', not any('Korai jelzes' in t for _, t in sent), sent)

sent = run(88, state_reset=True)
check('jump to 88% from a fresh window: only the 85 message is sent',
      len(sent) == 2 and all('kuszob 85%' in t for _, t in sent), sent)
check('jump to 88%: 70 is recorded as fired anyway', bool(state().get('claude_seven_day_threshold_70', {}).get('fired_for_reset')))
sent = run(89)
check('89% after the jump: 70 does not come back later', sent == [], sent)

# the live state of 2026-10-27 (70 fired this window, the old 80 key never armed): moving
# the line must not send anything again at the current 70-80%, and 85 still fires once
with open(STATE, 'w', encoding='utf-8') as f:
    json.dump({'claude_seven_day_threshold_70': {'fired_for_reset': RESET}, 'claude_seven_day_threshold_80': {}}, f)
sent = run(70)
check('old state file at 70%: no second message', sent == [], sent)
sent = run(84)
check('old state file at 84%: nothing is sent', sent == [], sent)
sent = run(85)
check('old state file at 85%: the 85 message goes out once', len(sent) == 2 and 'kuszob 85%' in sent[0][1], sent)
sent = run(86)
check('old state file at 86%: 85 does not repeat', sent == [], sent)

r = subprocess.run([sys.executable, SCRIPT, '--self-test'], capture_output=True, text=True)
check('--self-test passes', r.returncode == 0 and 'self-test: PASS' in r.stdout, r.stdout[-400:])

print('\nusage-quota-gate test: %d failed' % len(FAILS))
sys.exit(1 if FAILS else 0)
