#!/usr/bin/env bash
# <bitbar.title>VibeRelay</bitbar.title>
# <bitbar.version>v1</bitbar.version>
# <bitbar.author>viberelay</bitbar.author>
# <bitbar.desc>Live account usage for the viberelay proxy.</bitbar.desc>
# <bitbar.dependencies>bash,python3,viberelay</bitbar.dependencies>
#
# Refresh every 5s. File name convention: <name>.<refresh><unit>.sh
#
# Locate the viberelay binary. Respect VIBERELAY_BIN if set; otherwise try the
# default install path, then PATH.
set -eu

VIBERELAY="${VIBERELAY_BIN:-$HOME/.local/bin/viberelay}"
if [ ! -x "$VIBERELAY" ]; then
  VIBERELAY="$(command -v viberelay 2>/dev/null || true)"
fi

if [ -z "${VIBERELAY:-}" ] || [ ! -x "$VIBERELAY" ]; then
  echo "◉ ?"
  echo "---"
  echo "viberelay not found on PATH | color=red"
  echo "Install: https://github.com/YusufLisawi/viberelay | href=https://github.com/YusufLisawi/viberelay"
  exit 0
fi

JSON="$("$VIBERELAY" usage --once --json 2>/dev/null || true)"
if [ -z "$JSON" ]; then
  echo "◉ offline | color=gray"
  echo "---"
  echo "Start daemon | shell=$VIBERELAY param1=start terminal=false refresh=true"
  echo "Open dashboard | href=http://127.0.0.1:8327/dashboard"
  exit 0
fi

python3 - "$JSON" "$VIBERELAY" <<'PY'
import sys, json

try:
    data = json.loads(sys.argv[1])
except Exception:
    print("◉ ?")
    print("---")
    print("could not parse /usage | color=red")
    sys.exit(0)

bin_path = sys.argv[2]

if data.get("error") == "daemon_not_running":
    print("◉ offline | color=gray")
    print("---")
    print(f"Start daemon | shell={bin_path} param1=start terminal=false refresh=true")
    print("Open dashboard | href=http://127.0.0.1:8327/dashboard")
    sys.exit(0)

total = data.get("total_requests", 0) or 0
providers = data.get("provider_counts", {}) or {}
pu = data.get("provider_usage", {}) or {}
labels = data.get("account_labels", {}) or {}
accs = data.get("account_counts", {}) or {}

def lowest_remaining():
    low = None
    for prov, accts in pu.items():
        for win in (accts or {}).values():
            for key in ("primaryUsedPercent", "secondaryUsedPercent"):
                used = win.get(key)
                if isinstance(used, (int, float)):
                    remaining = max(0, 100 - used)
                    if low is None or remaining < low:
                        low = remaining
    return low

low = lowest_remaining()
if low is not None:
    print(f"◉ {total}  ·  {int(round(low))}% left")
else:
    print(f"◉ {total}")

print("---")
print(f"Total requests: {total} | font=Menlo")
print("---")

provider_order = sorted(providers.keys(), key=lambda k: -providers[k])
all_providers = list(dict.fromkeys(list(providers.keys()) + list(pu.keys()) + list(accs.keys())))
if not provider_order:
    provider_order = all_providers

for prov in provider_order:
    count = providers.get(prov, 0)
    print(f"{prov} · {count} req | size=13")
    windows = pu.get(prov, {}) or {}
    hits = accs.get(prov, {}) or {}
    files = list(dict.fromkeys(list(windows.keys()) + list(hits.keys())))
    for file in files:
        label = (labels.get(prov, {}) or {}).get(file, file.replace(".json", ""))
        win = windows.get(file, {}) or {}
        req_count = hits.get(file, 0)
        bits = [f"{req_count} req"]
        pp = win.get("primaryUsedPercent")
        if isinstance(pp, (int, float)):
            bits.append(f"5h {int(round(100 - pp))}% left")
        sp = win.get("secondaryUsedPercent")
        if isinstance(sp, (int, float)):
            bits.append(f"wk {int(round(100 - sp))}% left")
        plan = win.get("planType")
        if plan:
            bits.append(plan)
        print(f"-- {label}  ·  {'  ·  '.join(bits)} | font=Menlo size=12")
    print("-----")

print("Open dashboard | href=http://127.0.0.1:8327/dashboard")
print(f"Restart daemon | shell={bin_path} param1=restart terminal=false refresh=true")
print(f"Refresh now | refresh=true")
PY
