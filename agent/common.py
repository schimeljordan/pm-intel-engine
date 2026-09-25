# agent/common.py
from __future__ import annotations

import hashlib

import requests
import tldextract
from bs4 import BeautifulSoup
from readability import Document


def fetch(url: str, ua: str, timeout: int) -> bytes:
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    r = requests.get(url, headers=headers, timeout=(6, timeout), allow_redirects=True)
    r.raise_for_status()
    return r.content or b""


def extract_text(html: bytes) -> tuple[str, str]:
    txt = html.decode("utf-8", "ignore")
    doc = Document(txt)
    title = doc.short_title() or ""
    body_html = doc.summary(html_partial=True) or ""
    soup = BeautifulSoup(body_html, "html.parser")
    for bad in soup(["script", "style", "noscript", "form", "nav", "aside"]):
        bad.decompose()
    text = soup.get_text("\n").strip()
    if not title:
        parser = "xml" if txt.lstrip().startswith("<?xml") else "html.parser"
        s2 = BeautifulSoup(txt, features=parser)
        if s2.title and s2.title.string:
            title = s2.title.string.strip()
    return title, text


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b or b"").hexdigest()


def canonical_url(u: str) -> str:
    if not u:
        return ""
    # minimal normalization: strip tracking params & fragments
    from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

    pu = urlparse(u)
    q = [
        (k, v)
        for (k, v) in parse_qsl(pu.query, keep_blank_values=True)
        if not k.lower().startswith(("utm_", "gclid", "fbclid", "yclid"))
    ]
    pu = pu._replace(query=urlencode(q, doseq=True), fragment="")
    scheme = pu.scheme or "https"
    netloc = pu.netloc.lower()
    return urlunparse(pu._replace(scheme=scheme, netloc=netloc))


def domain(u: str) -> str:
    if not u:
        return ""
    ext = tldextract.extract(u)
    return ".".join(p for p in [ext.domain, ext.suffix] if p)
