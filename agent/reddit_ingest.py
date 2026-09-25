# agent/reddit_ingest.py
from __future__ import annotations

import os
import sqlite3
import time
import yaml
from datetime import datetime, timedelta
from typing import Any, Dict, Iterator, Optional, Tuple

from agent.common import sha256_bytes
from agent.db_migrations import ensure_schema

try:
    import praw
except ImportError as e:
    raise ImportError(
        "The 'praw' package is required for Reddit ingestion. Add it to requirements.txt"
    ) from e


def _mk_reddit(rconf: Dict[str, Any]) -> "praw.Reddit":
    # FIX 1.8: Reddit deprecated the password OAuth flow in 2023. Use the read-only
    # "script" client-credentials flow (client_id + client_secret + user_agent only).
    user_agent = (
        rconf.get("user_agent")
        or os.getenv("REDDIT_USER_AGENT")
        or "FireIntelAgent/1.0 by fire-intel-agent"
    )
    creds = {
        "client_id": rconf.get("client_id") or os.getenv("REDDIT_CLIENT_ID"),
        "client_secret": rconf.get("client_secret") or os.getenv("REDDIT_CLIENT_SECRET"),
        "user_agent": user_agent,
    }
    if not creds["client_id"] or not creds["client_secret"]:
        raise ValueError(
            "Missing reddit client_id/client_secret — skipping Reddit ingest gracefully"
        )
    return praw.Reddit(
        client_id=creds["client_id"],
        client_secret=creds["client_secret"],
        user_agent=creds["user_agent"],
        ratelimit_seconds=int(rconf.get("ratelimit_seconds", 30)),
    )


def iter_reddit_items(
    cfg: Dict[str, Any],
) -> Iterator[Tuple[str, str, str, Optional[str], str]]:
    rconf = cfg.get("reddit") or {}
    subs = rconf.get("subreddits") or []
    if not subs:
        return
    reddit = _mk_reddit(rconf)
    # Cap fetched posts per subreddit for faster iteration
    limit = min(350, int(rconf.get("limit_per_sub", 350)))
    lookback_days = int(rconf.get("lookback_days", 360))
    cutoff_ts = (datetime.utcnow() - timedelta(days=lookback_days)).timestamp()

    for sub in subs:
        stats = dict(fetched=0, yielded=0, old=0, nsfw=0, stickied=0, errors=0)
        try:
            for s in reddit.subreddit(sub).new(limit=limit):
                stats["fetched"] += 1
                if getattr(s, "stickied", False):
                    stats["stickied"] += 1
                    continue
                if rconf.get("exclude_nsfw", True) and getattr(s, "over_18", False):
                    stats["nsfw"] += 1
                    continue
                if getattr(s, "created_utc", None) and s.created_utc < cutoff_ts:
                    stats["old"] += 1
                    continue
                url = f"https://www.reddit.com{s.permalink}"
                title = s.title or "(untitled)"
                body = (s.selftext or "").strip()
                content = (title + ("\n\n" + body if body else "")).strip()
                if getattr(s, "is_self", True) is False and getattr(s, "url", ""):
                    content += f"\n\n[link] {s.url}"
                published_iso = datetime.utcfromtimestamp(s.created_utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                )
                stats["yielded"] += 1
                yield (f"reddit:r/{sub}", url, title, published_iso, content)
        except Exception as e:
            stats["errors"] += 1
            print(f"📥 Reddit r/{sub}: {e}")
        print(
            "📥 Reddit r/{}: fetched={} yielded={} old={} nsfw/flair={} "
            "stickied={} errors={}".format(
                sub,
                stats["fetched"],
                stats["yielded"],
                stats["old"],
                stats["nsfw"],
                stats["stickied"],
                stats["errors"],
            )
        )


def main() -> None:
    cfg = yaml.safe_load(open(os.environ.get("CONFIG_PATH", "config.yaml"), "r", encoding="utf-8"))
    try:
        items = list(iter_reddit_items(cfg))
    except Exception as e:
        print(f"Reddit ingest skipped: {e}")
        return
    if not items:
        print("Reddit ingest found no items")
        return

    db_path = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")
    ensure_schema(db_path)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    count = 0
    for source, url, title, published_iso, content in items:
        try:
            cur.execute(
                """INSERT INTO pages(url, source, title, fetched_at, published_at, sha256, content, text, processed, error)
                   VALUES(?,?,?,?,?,?,?,?,0,NULL)
                   ON CONFLICT(url) DO UPDATE SET
                     source=excluded.source, title=excluded.title, fetched_at=excluded.fetched_at,
                     published_at=COALESCE(excluded.published_at, pages.published_at),
                     sha256=excluded.sha256, content=excluded.content, text=excluded.text""",
                (
                    url,
                    source,
                    title,
                    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    published_iso,
                    sha256_bytes(content.encode("utf-8")),
                    content,
                    content,
                ),
            )
            count += 1
        except Exception as e:
            try:
                cur.execute(
                    """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                       VALUES(?,?,?,?,?,?,?,0,?)""",
                    (
                        url,
                        source,
                        title,
                        published_iso
                        or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "",
                        "",
                        "",
                        str(e),
                    ),
                )
            except Exception:
                pass
    con.commit()
    con.close()
    print(f"Reddit ingest recorded {count} items")


if __name__ == "__main__":
    main()
