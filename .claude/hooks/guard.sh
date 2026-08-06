#!/bin/bash
# ScaleSolo engineer-agent guardrails (PreToolUse hook).
# Active ONLY while the scheduled agent's flag file is fresh (<120 min old).
# Ray's interactive sessions pass through untouched unless the flag is live,
# and even then only commands scoped to the Veteran Nexus repo are checked.
# Merge policy: `gh pr merge N` is allowed ONLY when PR N carries the
# `ray-approved` label, which only Ray can add (any agent-mode command that
# mentions the label is denied). Everything else merge-shaped is denied.
# Stuck? Remove: ~/.claude/scheduled-tasks/scalesolo-engineer/.agent-mode

FLAG="$HOME/.claude/scheduled-tasks/scalesolo-engineer/.agent-mode"
if [ ! -f "$FLAG" ] || [ -z "$(find "$FLAG" -mmin -120 2>/dev/null)" ]; then
  exit 0
fi

INPUT=$(cat)
printf '%s' "$INPUT" | python3 -c '
import json, re, subprocess, sys

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
ti = data.get("tool_input", {}) or {}
cwd = data.get("cwd", "") or ""

def deny(msg):
    sys.stderr.write(
        "BLOCKED by ScaleSolo agent guardrail: " + msg + ". "
        "Agent mode is active. If you are Ray working interactively, delete "
        "~/.claude/scheduled-tasks/scalesolo-engineer/.agent-mode and retry."
    )
    sys.exit(2)

cmd = ti.get("command", "") or ""
fp = ti.get("file_path", "") or ""
scope_text = (cwd + " " + cmd + " " + fp).lower()
in_scope = ("scalesolo" in scope_text)
if not in_scope:
    sys.exit(0)

if tool in ("Edit", "Write", "NotebookEdit"):
    if re.search(r"\.env", fp, re.I):
        deny("editing env files")
    sys.exit(0)

if tool != "Bash":
    sys.exit(0)

# The approval label may never appear in an agent-mode command: the agent
# must not add, remove, or otherwise manipulate it. Reading labels via
# --json does not require typing the label name.
if "ray-approved" in cmd.lower():
    deny("touching the ray-approved label (only Ray may set it)")

# gh pr merge: allowed only for a PR Ray has labeled ray-approved.
m = re.search(r"\bgh\s+pr\s+merge\s+(?:.*?)?(\d+)", cmd, re.I)
if re.search(r"\bgh\s+pr\s+merge\b", cmd, re.I):
    if not m:
        deny("gh pr merge without an explicit PR number")
    n = m.group(1)
    try:
        r = subprocess.run(
            ["gh", "pr", "view", n, "--repo", "vernontm/scalesolo",
             "--json", "labels"],
            capture_output=True, text=True, timeout=20)
        labels = [l.get("name", "") for l in json.loads(r.stdout).get("labels", [])]
    except Exception:
        deny("could not verify approval label on PR " + n + " (failing closed)")
    if "ray-approved" not in labels:
        deny("PR " + n + " does not carry the ray-approved label; ask Ray to confirm it first")
    sys.exit(0)

RULES = [
    (r"git\s+push[^\n|;&]*(--force\b|\s-f\b)", "force push"),
    (r"git\s+push[^\n|;&]*\borigin\s+(main|master)\b", "push to main (open a PR from a claude/* branch instead)"),
    (r"git\s+push\b(?![^\n|;&]*claude/)", "push to a non-claude/* branch (always push explicitly: git push -u origin claude/<slug>)"),
    (r"\bgit\s+merge\b", "git merge (the only allowed merge path is gh pr merge on a ray-approved PR)"),
    (r"pulls/\d+/merge", "merging a PR via raw API (use gh pr merge so the approval label is checked)"),
    (r"git\s+reset\s+--hard", "git reset --hard"),
    (r"git\s+checkout\s+[^\n|;&]*--\s", "checkout-discarding working files"),
    (r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b", "rm -rf"),
    (r"\bpsql\b", "psql (migrations are propose-only: write the .sql into docs/migrations/)"),
    (r"\b(alter|drop|truncate|grant|revoke)\s+(table|role|schema|policy|index|function|database|user|all|select|insert|update|delete|usage)\b", "SQL DDL/DCL (propose a migration .sql instead)"),
    (r"\bcreate\s+(table|index|policy|role|extension|schema|function|trigger|view)\b", "SQL DDL (propose a migration .sql instead)"),
    (r"\binsert\s+into\b", "SQL write (DB access is read-only)"),
    (r"\bdelete\s+from\b", "SQL write (DB access is read-only)"),
    (r"\bupdate\s+\w+\s+set\b", "SQL write (DB access is read-only)"),
    (r"\bstripe\b[^\n|;&]*\b(create|update|delete|cancel|confirm|capture)\b", "Stripe write"),
    (r">{1,2}\s*\S*\.env", "writing to env files"),
    (r"sed\s+-i[^\n]*\.env", "editing env files"),
    (r"vercel\s+env\s+(add|rm)\b", "changing Vercel env vars"),
]

for pat, msg in RULES:
    if re.search(pat, cmd, re.I):
        deny(msg)

if "api.stripe.com" in cmd.lower():
    if re.search(r"-X\s*(POST|PUT|DELETE|PATCH)|--data\b|\s-d\s", cmd, re.I):
        deny("Stripe write via curl (reads are fine)")

sys.exit(0)
'
exit $?
