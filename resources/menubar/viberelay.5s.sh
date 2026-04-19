#!/usr/bin/env bash
# <bitbar.title>VibeRelay</bitbar.title>
# <bitbar.version>v1</bitbar.version>
# <bitbar.author>viberelay</bitbar.author>
# <bitbar.desc>Live account usage for the viberelay proxy.</bitbar.desc>
# <bitbar.dependencies>bash,python3,viberelay</bitbar.dependencies>
#
# SwiftBar: file name <name>.<refresh><unit>.sh — refreshes every 5s.
set -eu

VIBERELAY="${VIBERELAY_BIN:-$HOME/.local/bin/viberelay}"
if [ ! -x "$VIBERELAY" ]; then
  VIBERELAY="$(command -v viberelay 2>/dev/null || true)"
fi

# Menu-bar icon: SF Symbol, auto-templated by SwiftBar.
ICON=' | sfimage=waveform.path'

if [ -z "${VIBERELAY:-}" ] || [ ! -x "$VIBERELAY" ]; then
  echo "?${ICON}"
  echo "---"
  echo "viberelay not on PATH | color=red"
  echo "Install: https://github.com/YusufLisawi/viberelay | href=https://github.com/YusufLisawi/viberelay"
  exit 0
fi

JSON="$("$VIBERELAY" usage --once --json 2>/dev/null || true)"

python3 - "${JSON:-}" "$VIBERELAY" "$ICON" <<'PY'
import sys, json

raw = sys.argv[1]
bin_path = sys.argv[2]
icon = sys.argv[3]

def line(text, **attrs):
    if attrs:
        meta = " | " + " ".join(f"{k}={v}" for k, v in attrs.items())
    else:
        meta = ""
    print(f"{text}{meta}")

data = None
if raw:
    try:
        data = json.loads(raw)
    except Exception:
        data = None

# Menu-bar title line.
if data is None or data.get("error") == "daemon_not_running":
    print(f"offline{icon} color=gray")
    print("---")
    line("Server: stopped", color="#d55")
    print("---")
    line("Start server", shell=bin_path, param1="start", terminal="false", refresh="true")
    line("Open dashboard", href="http://127.0.0.1:8327/dashboard")
    line("Refresh", refresh="true")
    sys.exit(0)

total = int(data.get("total_requests", 0) or 0)
providers = data.get("provider_counts", {}) or {}
pu = data.get("provider_usage", {}) or {}
labels = data.get("account_labels", {}) or {}
accs = data.get("account_counts", {}) or {}
next_by_provider = data.get("next_account_by_provider", {}) or {}
last_group = data.get("last_group")
last_model = data.get("last_model")
last_at = data.get("last_at")

# Pool pressure: average used% across every account × both windows.
used_samples = []
worst_remaining = None
worst_label = None
for prov, accts in pu.items():
    for file, win in (accts or {}).items():
        for key in ("primaryUsedPercent", "secondaryUsedPercent"):
            used = win.get(key)
            if isinstance(used, (int, float)):
                clamped = max(0, min(100, used))
                used_samples.append(clamped)
                remaining = 100 - clamped
                if worst_remaining is None or remaining < worst_remaining:
                    worst_remaining = remaining
                    worst_label = (labels.get(prov, {}) or {}).get(file, file.replace(".json", ""))

if used_samples:
    pool_used = sum(used_samples) / len(used_samples)
    print(f"{int(round(pool_used))}%{icon}")
else:
    print(f"{total}{icon}")

print("---")
line(f"Server: running (port 8327)", color="#9c9")
if used_samples:
    line(
        f"Pool: {int(round(sum(used_samples)/len(used_samples)))}% used "
        f"across {len(used_samples)} windows · {total} req",
        color="#aaa",
        size=11,
    )
    if worst_remaining is not None and worst_label:
        line(
            f"Tightest: {int(round(worst_remaining))}% left ({worst_label})",
            color="#aaa",
            size=11,
        )
else:
    line(f"{total} req", color="#aaa", size=11)

if last_group or last_model:
    lg = last_group or "—"
    lm = last_model or "—"
    line(f"Last: {lg} → {lm}", size=11, font="Menlo")
print("---")

def fmt_reset_seconds(seconds):
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return None
    if seconds < 60:
        return f"{int(round(seconds))}s"
    if seconds < 3600:
        return f"{int(round(seconds / 60))}m"
    if seconds < 86400:
        hours = int(seconds // 3600)
        minutes = int(round((seconds % 3600) / 60))
        return f"{hours}h {minutes}m"
    return f"{int(round(seconds / 86400))}d"

# Order providers: busiest first, then unused providers alphabetical.
provider_order = sorted(providers.keys(), key=lambda k: -providers[k])
seen = set(provider_order)
for prov in sorted(list(pu.keys()) + list(accs.keys())):
    if prov not in seen:
        provider_order.append(prov)
        seen.add(prov)

for prov in provider_order:
    windows = pu.get(prov, {}) or {}
    hits = accs.get(prov, {}) or {}
    files = list(dict.fromkeys(list(windows.keys()) + list(hits.keys())))
    if not files:
        continue
    next_file = next_by_provider.get(prov)
    line(prov.upper(), color="#888", size=10)
    for file in files:
        label = (labels.get(prov, {}) or {}).get(file, file.replace(".json", ""))
        win = windows.get(file, {}) or {}
        req_count = hits.get(file, 0)
        pp = win.get("primaryUsedPercent")
        reset = fmt_reset_seconds(win.get("primaryResetSeconds"))
        bits = []
        if isinstance(pp, (int, float)):
            bits.append(f"{int(round(100 - pp))}%")
        if reset:
            bits.append(reset)
        if req_count:
            bits.append(f"{req_count} req")
        detail = f"  ({', '.join(bits)})" if bits else ""
        marker = "▶ " if file == next_file else "  "
        color = "#7ec27e" if file == next_file else None
        attrs = {"font": "Menlo", "size": 12}
        if color:
            attrs["color"] = color
        line(f"{marker}{label}{detail}", **attrs)

print("---")
line("Open Dashboard", href="http://127.0.0.1:8327/dashboard")
line("Restart Server", shell=bin_path, param1="restart", terminal="false", refresh="true")
line("Stop Server", shell=bin_path, param1="stop", terminal="false", refresh="true")
line("Refresh", refresh="true")
PY
