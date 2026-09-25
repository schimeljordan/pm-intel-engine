from __future__ import annotations

import difflib
import sqlite3
import time

import yaml
from agent.common import canonical_url, extract_text, fetch, sha256_bytes
from agent.db_migrations import ensure_schema

TRACK_SECTIONS = [
    "competitors",
    "property_management",
    "facility_management_cmms",
    "gov_permitting_inspection",
]


def _diff_excerpt(old: str, new: str, max_chars: int = 900) -> str:
    a = (old or "").splitlines()
    b = (new or "").splitlines()
    diff = list(difflib.unified_diff(a, b, lineterm=""))
    return "\n".join(diff)[:max_chars]


def main():
    cfg = yaml.safe_load(open(os.environ.get("CONFIG_PATH", "config.yaml"), "r", encoding="utf-8"))
    ua = cfg.get("crawler", {}).get(
        "user_agent", "FireIntelAgent/1.0 (+https://example.com)"
    )
    timeout = int(cfg.get("crawler", {}).get("timeout_seconds", 30))
    db_path = cfg.get("storage", {}).get("db_path", "data/scraper.db")
    ensure_schema(db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def iter_sites():
        for sec in TRACK_SECTIONS:
            for site in cfg.get("sources", {}).get(sec, []) or []:
                yield sec, site

    for section, site in iter_sites():
        name = site.get("name", section.title())
        for url in site.get("pages") or []:
            url = canonical_url(url)
            try:
                html = fetch(url, ua, timeout)
                title, text = extract_text(html)
                new_sha = sha256_bytes(html)
                src_tag = f"{section}:{name}"

                row = cur.execute(
                    "SELECT sha256, content FROM pages WHERE url=?", (url,)
                ).fetchone()
                old_sha = row["sha256"] if row else ""
                old_content = row["content"] if row else ""

                cur.execute(
                    """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                       VALUES(?,?,?,?,?,?,?,0,NULL)
                       ON CONFLICT(url) DO UPDATE SET
                         source=excluded.source, title=excluded.title, fetched_at=excluded.fetched_at,
                         sha256=excluded.sha256, content=excluded.content, text=excluded.text""",
                    (
                        url,
                        src_tag,
                        title,
                        now,
                        new_sha,
                        html.decode("utf-8", "ignore"),
                        text,
                    ),
                )
                if old_sha and old_sha != new_sha:
                    diff_excerpt = _diff_excerpt(
                        old_content or "", html.decode("utf-8", "ignore")
                    )
                    cur.execute(
                        "INSERT INTO changes(url, changed_at, source, old_sha, new_sha, diff_excerpt) "
                        "VALUES(?,?,?,?,?,?)",
                        (url, now, src_tag, old_sha, new_sha, diff_excerpt),
                    )
            except Exception as e:
                try:
                    cur.execute(
                        """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                           VALUES(?,?,?,?,?,?,?,0,?)""",
                        (url, f"{section}:{name}", "", now, "", "", "", str(e)),
                    )
                except Exception:
                    pass

    con.commit()
    con.close()
    print("Site tracker finished.")


if __name__ == "__main__":
    main()
