#!/usr/bin/env python3
"""
Sanabreh outreach dashboard.

A small local web app to manage the influencer outreach campaign:
  - see every lead and its status (not contacted / waiting / follow-up due / replied)
  - click to send the next batch of first-touch emails
  - click to check the inbox for replies
  - click to send follow-ups that are due

Run it:
    python3 scripts/outreach-dashboard.py
then open http://localhost:8787 in your browser.

It shells out to send-outreach.py for anything that sends mail or reads the
inbox, so all the SMTP/IMAP logic (and the gitignored password) lives in one
place. Read-only state is computed from the JSON files on disk.
"""

import json
import subprocess
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).parent
SENDER = HERE / "send-outreach.py"
RECIPIENTS_FILE = HERE / "outreach-recipients.json"
SENT_LOG = HERE / "outreach-sent-log.txt"
STATE_FILE = HERE / "outreach-state.json"
RUN_LOG = HERE / "dashboard-run.log"

PORT = 8787
MAX_TOUCHES = 3
FOLLOWUP_AFTER_DAYS = 3

# one action at a time
_RUN = {"proc": None, "name": None}
_LOCK = threading.Lock()


# ---------- data helpers ----------
def load_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return default
    return default


def load_sent():
    out = set()
    if SENT_LOG.exists():
        for line in SENT_LOG.read_text().splitlines():
            line = line.strip().lower()
            if line and not line.startswith("#"):
                out.add(line)
    return out


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def days_since(iso):
    try:
        return (datetime.now() - datetime.fromisoformat(iso)).total_seconds() / 86400.0
    except Exception:
        return None


def reconcile(state, recipients):
    """Seed state entries for contacted emails that predate state tracking."""
    by_email = {r["email"].lower(): r for r in recipients}
    changed = False
    for email in load_sent():
        if email not in state:
            r = by_email.get(email, {})
            state[email] = {
                "email": email, "name": r.get("name", ""), "handle": r.get("handle", ""),
                "followers": r.get("followers", 0), "first_sent": now_iso(),
                "last_sent": now_iso(), "touches": 1, "subject": "",
                "replied": False, "replied_at": None,
            }
            changed = True
    if changed:
        save_state(state)
    return state


def compute():
    recipients = load_json(RECIPIENTS_FILE, [])
    state = reconcile(load_json(STATE_FILE, {}), recipients)
    leads = []
    counts = {"total": 0, "not_contacted": 0, "waiting": 0, "followup_due": 0, "replied": 0}
    for r in recipients:
        e = r["email"].lower()
        s = state.get(e)
        row = {
            "name": r.get("name", ""), "handle": r.get("handle", ""),
            "email": r["email"], "followers": r.get("followers", 0),
            "status": "not_contacted", "touches": 0, "last_days": None, "next_touch": 1,
        }
        if s:
            row["touches"] = s.get("touches", 0)
            d = days_since(s.get("last_sent", ""))
            row["last_days"] = round(d, 1) if d is not None else None
            if s.get("replied"):
                row["status"] = "replied"
            elif s.get("touches", 0) >= MAX_TOUCHES:
                row["status"] = "done"
            elif d is not None and d >= FOLLOWUP_AFTER_DAYS:
                row["status"] = "followup_due"
                row["next_touch"] = s.get("touches", 0) + 1
            else:
                row["status"] = "waiting"
        counts["total"] += 1
        if row["status"] in counts:
            counts[row["status"]] += 1
        elif row["status"] == "done":
            counts["waiting"] += 0  # rolled into nothing; shown as done in table
        leads.append(row)
    # sort: follow-up due first, then not contacted, then waiting, replied last
    order = {"followup_due": 0, "not_contacted": 1, "waiting": 2, "done": 3, "replied": 4}
    leads.sort(key=lambda x: (order.get(x["status"], 9), x["followers"]))
    counts["remaining"] = counts["not_contacted"]
    return {"counts": counts, "leads": leads, "running": _RUN["name"]}


# ---------- actions ----------
def start_action(name, extra_args):
    with _LOCK:
        if _RUN["proc"] and _RUN["proc"].poll() is None:
            return False, f"Busy: '{_RUN['name']}' is still running."
        RUN_LOG.write_text(f"$ {name}\n")
        logf = open(RUN_LOG, "a")
        proc = subprocess.Popen(
            [sys.executable, str(SENDER), *extra_args],
            cwd=str(HERE.parent), stdout=logf, stderr=subprocess.STDOUT,
        )
        _RUN["proc"] = proc
        _RUN["name"] = name
        return True, f"Started: {name}"


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass  # quiet

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._html(PAGE)
        elif path == "/api/state":
            self._json(compute())
        elif path == "/api/log":
            running = bool(_RUN["proc"] and _RUN["proc"].poll() is None)
            text = RUN_LOG.read_text() if RUN_LOG.exists() else ""
            self._json({"running": running, "name": _RUN["name"] if running else None,
                        "log": text[-6000:]})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)
        n = qs.get("n", ["25"])[0]
        if path == "/api/run":
            ok, msg = start_action(f"send batch of {n}", ["--send", "--limit", str(n)])
            self._json({"ok": ok, "msg": msg})
        elif path == "/api/check-replies":
            ok, msg = start_action("check replies", ["--check-replies"])
            self._json({"ok": ok, "msg": msg})
        elif path == "/api/followups":
            ok, msg = start_action(f"follow-ups (up to {n})", ["--followups", "--send", "--limit", str(n)])
            self._json({"ok": ok, "msg": msg})
        else:
            self._json({"error": "not found"}, 404)


PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>Sanabreh Outreach</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#111112;--card:#1b1b1e;--line:#2a2a2f;--text:#f4f4f5;--muted:#9a9aa2;--orange:#ff9b26;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:22px 26px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
h1{font-size:19px;margin:0;font-weight:800}
h1 span{color:var(--orange)}
.wrap{padding:22px 26px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card .n{font-size:26px;font-weight:800}
.card .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
button{background:var(--orange);color:#111;border:0;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer}
button.secondary{background:#26262b;color:var(--text);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
input[type=number]{width:64px;background:#26262b;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
a{color:var(--orange);text-decoration:none}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700}
.b-not_contacted{background:#2a2a2f;color:#cfcfd6}
.b-waiting{background:#1e2f45;color:#7db9ff}
.b-followup_due{background:#3a2a12;color:var(--orange)}
.b-replied{background:#12331f;color:#5ad689}
.b-done{background:#2a2a2f;color:#8a8a92}
.log{margin-top:18px;background:#0c0c0d;border:1px solid var(--line);border-radius:10px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#bfbfc6;white-space:pre-wrap;max-height:240px;overflow:auto}
.muted{color:var(--muted)}
.run{color:var(--orange);font-weight:700}
</style></head><body>
<header><h1>Sanabreh <span>Outreach</span></h1><div id="run" class="run"></div></header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div class="controls">
    Batch size <input type="number" id="n" value="25" min="1" max="50">
    <button id="b-run">Send next batch</button>
    <button class="secondary" id="b-rep">Check replies</button>
    <button class="secondary" id="b-fu">Send due follow-ups</button>
    <span class="muted" id="msg"></span>
  </div>
  <table><thead><tr><th>Name</th><th>Handle</th><th>Followers</th><th>Status</th><th>Touches</th><th>Last touch</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <div class="log" id="log">Ready.</div>
</div>
<script>
const LABEL={not_contacted:"Not contacted",waiting:"Waiting",followup_due:"Follow-up due",replied:"Replied",done:"Done (3 touches)"};
async function refresh(){
  const s=await (await fetch('/api/state')).json();
  const c=s.counts;
  document.getElementById('cards').innerHTML=[
    ['Total',c.total],['Not contacted',c.not_contacted],['Waiting',c.waiting],
    ['Follow-up due',c.followup_due],['Replied',c.replied]
  ].map(([l,n])=>`<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  document.getElementById('rows').innerHTML=s.leads.map(r=>`<tr>
    <td>${r.name==='there'?'<span class="muted">(no name)</span>':r.name}</td>
    <td><a href="https://www.tiktok.com/@${r.handle}" target="_blank">@${r.handle}</a></td>
    <td>${r.followers.toLocaleString()}</td>
    <td><span class="badge b-${r.status}">${LABEL[r.status]||r.status}</span></td>
    <td>${r.touches}</td>
    <td>${r.last_days==null?'<span class="muted">-</span>':r.last_days+'d ago'}</td>
  </tr>`).join('');
}
async function poll(){
  const l=await (await fetch('/api/log')).json();
  document.getElementById('log').textContent=l.log||'Ready.';
  const r=document.getElementById('run');
  const busy=l.running;
  r.textContent=busy?('Running: '+l.name):'';
  for(const id of ['b-run','b-rep','b-fu']) document.getElementById(id).disabled=busy;
  if(busy){document.getElementById('log').scrollTop=1e9;}
  refresh();
}
async function act(url){
  const n=document.getElementById('n').value;
  const res=await (await fetch(url+'?n='+n,{method:'POST'})).json();
  document.getElementById('msg').textContent=res.msg||'';
  setTimeout(poll,400);
}
document.getElementById('b-run').onclick=()=>act('/api/run');
document.getElementById('b-rep').onclick=()=>act('/api/check-replies');
document.getElementById('b-fu').onclick=()=>act('/api/followups');
refresh();setInterval(poll,2500);
</script></body></html>"""


def main():
    print(f"Sanabreh outreach dashboard running at  http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
