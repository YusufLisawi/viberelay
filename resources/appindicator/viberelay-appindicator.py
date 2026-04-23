#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import AyatanaAppIndicator3 as AppIndicator3, GLib, Gtk, Pango

DASHBOARD_URL = 'http://127.0.0.1:8327/dashboard'
REFRESH_MS = 5000
ICON_CACHE_DIR = Path.home() / '.cache' / 'viberelay' / 'appindicator'


def resolve_viberelay() -> str | None:
    candidate = os.environ.get('VIBERELAY_BIN')
    if candidate and os.access(candidate, os.X_OK):
        return candidate
    local = Path.home() / '.local' / 'bin' / 'viberelay'
    if local.exists() and os.access(local, os.X_OK):
        return str(local)
    found = shutil_which('viberelay')
    return found


def shutil_which(name: str) -> str | None:
    for directory in os.environ.get('PATH', '').split(':'):
        if not directory:
            continue
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def ensure_icon_dir() -> None:
    ICON_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def render_icon(text: str, state: str) -> str:
    ensure_icon_dir()
    icon_path = ICON_CACHE_DIR / f"{state}-{text.replace('%', 'pct').replace(' ', '_').replace('/', '_')}.svg"
    parts = text.split(' ', 1)
    icon_prefix = GLib.markup_escape_text(parts[0]) if parts else ''
    icon_value = GLib.markup_escape_text(parts[1]) if len(parts) > 1 else ''
    width = max(42, len(text) * 12)
    center = width / 2
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="22" viewBox="0 0 {width} 22">
  <text x="{center}" y="15" text-anchor="middle" font-family="Inter, Sans" font-weight="700" fill="#ffffff">
    <tspan font-size="16" dy="1">{icon_prefix}</tspan>
    <tspan font-size="13" dy="-1"> {icon_value}</tspan>
  </text>
</svg>
'''
    icon_path.write_text(svg, encoding='utf8')
    return str(icon_path)


def format_reset(seconds) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return '—'
    if seconds < 60:
        return f'{int(round(seconds))}s'
    if seconds < 3600:
        return f'{int(round(seconds / 60))}m'
    if seconds < 86400:
        hours = int(seconds // 3600)
        minutes = int(round((seconds % 3600) / 60))
        return f'{hours}h {minutes}m'
    return f'{int(round(seconds / 86400))}d'


def format_summary(payload: dict) -> tuple[str, str, str, list[dict], str]:
    if payload.get('error') == 'daemon_not_running':
        return 'VR off', 'offline', 'Daemon stopped', [], '֍ off'

    provider_counts = payload.get('provider_counts', {}) or {}
    provider_usage = payload.get('provider_usage', {}) or {}
    labels = payload.get('account_labels', {}) or {}
    account_counts = payload.get('account_counts', {}) or {}
    total = int(payload.get('total_requests', 0) or 0)
    last_group = payload.get('last_group') or '—'
    last_model = payload.get('last_model') or '—'
    stats_day = payload.get('stats_day')

    primary_samples = []
    secondary_samples = []
    worst_remaining = None
    worst_label = None
    worst_window = None
    details = []
    for provider, accounts in provider_usage.items():
        for file_name, window in (accounts or {}).items():
            primary_used = window.get('primaryUsedPercent')
            if isinstance(primary_used, (int, float)):
                clamped = max(0.0, min(100.0, float(primary_used)))
                primary_samples.append(clamped)
                remaining = 100.0 - clamped
                if worst_remaining is None or remaining < worst_remaining:
                    worst_remaining = remaining
                    worst_label = (labels.get(provider, {}) or {}).get(file_name, file_name.replace('.json', ''))
                    worst_window = '5h'

            secondary_used = window.get('secondaryUsedPercent')
            if isinstance(secondary_used, (int, float)):
                clamped = max(0.0, min(100.0, float(secondary_used)))
                secondary_samples.append(clamped)
                remaining = 100.0 - clamped
                if worst_remaining is None or remaining < worst_remaining:
                    worst_remaining = remaining
                    worst_label = (labels.get(provider, {}) or {}).get(file_name, file_name.replace('.json', ''))
                    worst_window = 'weekly'

    primary_left = int(round(100.0 - (sum(primary_samples) / len(primary_samples)))) if primary_samples else 100
    secondary_left = int(round(100.0 - (sum(secondary_samples) / len(secondary_samples)))) if secondary_samples else 100

    state = 'normal'
    overall_left = min(primary_left, secondary_left)
    if not primary_samples and not secondary_samples:
        state = 'idle'
    elif overall_left <= 10:
        state = 'critical'
    elif overall_left <= 30:
        state = 'warn'

    text = f'VR {primary_left}%' if primary_samples or secondary_samples else f'VR {total} req'
    icon_text = f'֍ {primary_left}%'
    lines = [
        f'5h Pool Left: {primary_left}%',
        f'Weekly Pool Left: {secondary_left}%'
    ] if primary_samples or secondary_samples else [f'Requests today: {total}']
    if stats_day:
        lines.append(f'Stats day: {stats_day}')
    if worst_label and worst_window:
        lines.append(f'Tightest: {worst_label} ({worst_window}, {int(round(worst_remaining))}% left)')
    lines.append(f'Last route: {last_group} → {last_model}')
    lines.append('')

    provider_order = sorted(provider_counts.keys(), key=lambda key: -provider_counts[key])
    seen = set(provider_order)
    for provider in sorted(list(provider_usage.keys()) + list(account_counts.keys())):
        if provider not in seen:
            provider_order.append(provider)
            seen.add(provider)

    for provider in provider_order:
        windows = provider_usage.get(provider, {}) or {}
        hits = account_counts.get(provider, {}) or {}
        files = list(dict.fromkeys(list(windows.keys()) + list(hits.keys())))
        if not files:
            continue
        lines.append(provider.upper())
        details.append({'kind': 'provider', 'label': provider.upper()})
        for file_name in files:
            label = (labels.get(provider, {}) or {}).get(file_name, file_name.replace('.json', ''))
            window = windows.get(file_name, {}) or {}
            primary_used = window.get('primaryUsedPercent')
            primary_left = int(round(100 - primary_used)) if isinstance(primary_used, (int, float)) else None
            secondary_used = window.get('secondaryUsedPercent')
            secondary_left = int(round(100 - secondary_used)) if isinstance(secondary_used, (int, float)) else None
            req_count = hits.get(file_name, 0)
            primary_line = f"{primary_left if primary_left is not None else '—'}% left"
            primary_reset = f"resets in {format_reset(window.get('primaryResetSeconds'))}"
            weekly_line = f"{secondary_left if secondary_left is not None else '—'}% left"
            weekly_reset = f"resets in {format_reset(window.get('secondaryResetSeconds'))}"
            request_line = f'{req_count} req'
            lines.append(f'  {label}')
            lines.append(f'    5h {primary_line} · {primary_reset}')
            lines.append(f'    Weekly {weekly_line} · {weekly_reset}')
            lines.append(f'    {request_line}')
            details.append({
                'kind': 'account',
                'label': label,
                'primary': primary_line,
                'primary_reset': primary_reset,
                'weekly': weekly_line,
                'weekly_reset': weekly_reset,
                'requests': request_line,
            })
        lines.append('')
        details.append({'kind': 'spacer'})

    return text, state, '\n'.join(lines).strip(), details, icon_text if primary_samples or secondary_samples else f'{total}'


class Indicator:
    def __init__(self) -> None:
        self.viberelay = resolve_viberelay()
        self.indicator = AppIndicator3.Indicator.new(
            'viberelay-indicator',
            'network-transmit-receive-symbolic',
            AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
        self.menu = Gtk.Menu()
        self.header_label = Gtk.Label()
        self.header_label.set_xalign(0.0)
        self.header_label.set_yalign(0.0)
        self.header_label.set_selectable(False)
        self.header_label.set_line_wrap(True)
        self.header_label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        self.header_label.set_width_chars(40)
        self.header_label.set_max_width_chars(40)
        self.header_item = Gtk.MenuItem()
        self.header_item.connect('activate', lambda *_args: None)
        self.header_item.add(self.header_label)
        self.menu.append(self.header_item)
        self.details_separator = Gtk.SeparatorMenuItem()
        self.menu.append(self.details_separator)
        self.detail_items: list[Gtk.MenuItem] = []
        self.last_detail_signature: str | None = None
        self.action_separator = Gtk.SeparatorMenuItem()
        self.menu.append(self.action_separator)

        self.open_item = Gtk.MenuItem(label='Open dashboard')
        self.open_item.connect('activate', self.open_dashboard)
        self.menu.append(self.open_item)

        self.restart_item = Gtk.MenuItem(label='Restart daemon')
        self.restart_item.connect('activate', self.restart_daemon)
        self.menu.append(self.restart_item)

        self.refresh_item = Gtk.MenuItem(label='Refresh now')
        self.refresh_item.connect('activate', self.refresh_now)
        self.menu.append(self.refresh_item)

        self.quit_item = Gtk.MenuItem(label='Quit indicator')
        self.quit_item.connect('activate', self.quit)
        self.menu.append(self.quit_item)

        self.menu.show_all()
        self.indicator.set_menu(self.menu)
        self.apply_state('VR ?', 'error', 'viberelay not found', [], '?')

    def detail_signature(self, details: list[dict]) -> str:
        return json.dumps(details, sort_keys=True)

    def provider_markup(self, label: str) -> str:
        return f"<span weight='bold' foreground='#ffffff'>{GLib.markup_escape_text(label)}</span>"

    def account_markup(self, detail: dict) -> str:
        return (
            f"<span weight='bold' foreground='#ffffff'>{GLib.markup_escape_text(detail['label'])}</span>   <span foreground='#ffffff'>{GLib.markup_escape_text(detail['requests'])}</span>\n"
            f"<span foreground='#ffffff'>5h</span>   <span weight='bold' foreground='#ffffff'>{GLib.markup_escape_text(detail['primary'])}</span>   <span foreground='#ffffff'>{GLib.markup_escape_text(detail['primary_reset'])}</span>\n"
            f"<span foreground='#ffffff'>Weekly</span>   <span weight='bold' foreground='#ffffff'>{GLib.markup_escape_text(detail['weekly'])}</span>   <span foreground='#ffffff'>{GLib.markup_escape_text(detail['weekly_reset'])}</span>"
        )

    def build_account_widget(self, detail: dict) -> Gtk.Label:
        label = Gtk.Label()
        label.set_xalign(0.0)
        label.set_yalign(0.0)
        label.set_selectable(False)
        label.set_line_wrap(True)
        label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        label.set_width_chars(56)
        label.set_max_width_chars(56)
        label.set_markup(self.account_markup(detail))
        return label

    def build_detail_item(self, detail: dict) -> Gtk.MenuItem:
        kind = detail.get('kind')
        if kind == 'provider':
            label = Gtk.Label()
            label.set_xalign(0.0)
            label.set_markup(self.provider_markup(detail['label']))
            item = Gtk.MenuItem()
            item.connect('activate', lambda *_args: None)
            item.add(label)
            return item
        if kind == 'spacer':
            return Gtk.SeparatorMenuItem()
        label = self.build_account_widget(detail)
        item = Gtk.MenuItem()
        item.connect('activate', lambda *_args: None)
        item.set_size_request(480, -1)
        item.add(label)
        return item

    def update_detail_item(self, item: Gtk.MenuItem, detail: dict) -> None:
        kind = detail.get('kind')
        child = item.get_child()
        if kind == 'provider' and isinstance(child, Gtk.Label):
            child.set_markup(self.provider_markup(detail['label']))
            return
        if kind == 'account' and isinstance(child, Gtk.Label):
            child.set_markup(self.account_markup(detail))

    def set_details(self, details: list[dict]) -> None:
        signature = self.detail_signature(details)
        if signature == self.last_detail_signature:
            return

        if len(details) == len(self.detail_items):
            reusable = True
            for item, detail in zip(self.detail_items, details):
                kind = detail.get('kind')
                if kind == 'spacer' and not isinstance(item, Gtk.SeparatorMenuItem):
                    reusable = False
                    break
                if kind != 'spacer' and isinstance(item, Gtk.SeparatorMenuItem):
                    reusable = False
                    break
            if reusable:
                for item, detail in zip(self.detail_items, details):
                    self.update_detail_item(item, detail)
                self.last_detail_signature = signature
                self.menu.show_all()
                return

        for item in self.detail_items:
            self.menu.remove(item)
        self.detail_items.clear()

        insert_at = 2
        for detail in details:
            item = self.build_detail_item(detail)
            self.menu.insert(item, insert_at)
            self.detail_items.append(item)
            insert_at += 1

        self.last_detail_signature = signature
        self.menu.show_all()

    def query(self) -> tuple[str, str, str, list[dict], str]:
        if not self.viberelay:
            return 'VR ?', 'error', 'viberelay not on PATH', [], '֍ ?'
        try:
            result = subprocess.run(
                [self.viberelay, 'usage', '--once', '--json'],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
        except Exception as exc:
            return 'VR !', 'error', f'failed to query viberelay: {exc}', [], '֍ !'
        raw = (result.stdout or '').strip()
        try:
            payload = json.loads(raw) if raw else None
        except Exception:
            payload = None
        if payload is None:
            return 'VR !', 'error', result.stderr.strip() or 'invalid response from viberelay', [], '֍ !'
        return format_summary(payload)

    def icon_for_state(self, state: str) -> str:
        return {
            'normal': 'network-transmit-receive-symbolic',
            'idle': 'network-idle-symbolic',
            'warn': 'dialog-warning-symbolic',
            'critical': 'dialog-warning-symbolic',
            'offline': 'network-offline-symbolic',
            'error': 'dialog-error-symbolic',
        }.get(state, 'network-transmit-receive-symbolic')

    def apply_state(self, text: str, state: str, tooltip: str, details: list[dict], icon_text: str) -> None:
        self.indicator.set_icon_full(render_icon(icon_text, state), state)
        self.indicator.set_label('', 'viberelay')
        header_lines = tooltip.split('\n')[:2]
        self.header_label.set_markup('\n'.join(
            f"<span weight='bold' foreground='#cdd6f4'>{GLib.markup_escape_text(line)}</span>" for line in header_lines
        ))
        self.set_details(details)
        self.restart_item.set_sensitive(self.viberelay is not None)
        self.refresh_item.set_sensitive(True)
        self.indicator.set_title('viberelay')
        self.indicator.set_secondary_activate_target(self.open_item)

    def refresh(self) -> bool:
        text, state, tooltip, details, icon_text = self.query()
        self.apply_state(text, state, tooltip, details, icon_text)
        self.header_item.set_tooltip_text(tooltip)
        self.open_item.set_tooltip_text(DASHBOARD_URL)
        self.restart_item.set_tooltip_text('Restart viberelay-daemon')
        return True

    def refresh_now(self, *_args) -> None:
        self.refresh()

    def open_dashboard(self, *_args) -> None:
        subprocess.Popen(['xdg-open', DASHBOARD_URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def restart_daemon(self, *_args) -> None:
        if not self.viberelay:
            return
        subprocess.Popen([self.viberelay, 'restart'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        GLib.timeout_add(1000, self.refresh)

    def quit(self, *_args) -> None:
        Gtk.main_quit()


def main() -> int:
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    indicator = Indicator()
    indicator.refresh()
    GLib.timeout_add(REFRESH_MS, indicator.refresh)
    Gtk.main()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
