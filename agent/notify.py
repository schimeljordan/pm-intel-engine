from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Dict

import requests


def _load_recent_items(days: int = 3) -> List[Dict[str, str]]:
    """Load news items from dashboard/latest.json within the last *days* days."""
    latest_path = Path("dashboard/latest.json")
    if not latest_path.exists():
        return []
    data = json.loads(latest_path.read_text(encoding="utf-8"))
    items = data.get("items") or []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    recent: List[Dict[str, str]] = []
    for it in items:
        dt_str = (it.get("date") or "").strip()
        if not dt_str:
            recent.append(it)  # FIX 1.10: fail open when no date is present
            continue
        try:
            dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            # Treat naive datetimes as UTC so the comparison is timezone-aware.
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:
            recent.append(it)  # FIX 1.10: include items we can't parse rather than dropping
            continue
        if dt >= cutoff:
            recent.append(it)
    return recent


def _format_message(items: List[Dict[str, str]], dashboard_url: str) -> str:
    lines = ["Breaking news (last 3 days):"]
    for it in items:
        title = it.get("title") or it.get("url")
        url = it.get("url") or ""
        summary = it.get("summary") or ""
        if summary:
            lines.append(f"- {title}: {summary} ({url})")
        else:
            lines.append(f"- {title} ({url})")
    if dashboard_url:
        lines.append("")
        lines.append(f"Dashboard: {dashboard_url}")
    return "\n".join(lines)


def _post(webhook_url: str, text: str) -> None:
    """Post *text* to either a Slack or Teams webhook.

    Teams expects a MessageCard payload while Slack accepts a simple
    ``{"text": ...}`` structure. We auto-detect which format to use based on the
    webhook URL. Errors are logged so a failed post does not halt the pipeline.
    """

    if "office.com" in webhook_url or "teams.microsoft" in webhook_url:
        payload = {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "summary": text.splitlines()[0][:60],
            "text": text,
        }
    else:
        payload = {"text": text}
    try:
        r = requests.post(webhook_url, json=payload, timeout=10)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"Webhook post failed: {e}")


def main() -> None:
    teams_url = os.getenv("TEAMS_WEBHOOK_URL")
    slack_url = os.getenv("SLACK_WEBHOOK_URL")
    if not teams_url and not slack_url:
        print("No webhook configured; skipping notification")
        return
    items = _load_recent_items()
    if not items:
        print("No recent items; skipping notification")
        return
    dash_url = (os.getenv("DASHBOARD_BASE_URL") or "").rstrip("/")
    msg = _format_message(items, dash_url)
    if teams_url:
        _post(teams_url, msg)
        print("Posted update to Teams")
    if slack_url:
        _post(slack_url, msg)
        print("Posted update to Slack")


if __name__ == "__main__":
    main()
