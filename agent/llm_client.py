# agent/llm_client.py
from __future__ import annotations

import os
import logging
from typing import List, Dict, Any, Optional


# --- Token estimation (works without tiktoken too) ---
def _estimate_tokens(s: str) -> int:
    try:
        import tiktoken  # type: ignore

        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(s or ""))
    except Exception:
        # crude fallback ~4 chars/token
        return max(1, len((s or "")) // 4)


def _messages_to_token_count(messages: List[Dict[str, str]]) -> int:
    total = 0
    for m in messages:
        total += _estimate_tokens(m.get("role", "")) + _estimate_tokens(
            m.get("content", "")
        )
    return total


# --- OpenAI client (prefers v1.x) ---
_client_v1 = None
_legacy_openai = None
_is_v1 = False


def _init_client() -> None:
    global _client_v1, _legacy_openai, _is_v1
    api_key = (
        os.environ.get("OPENAI_SUMMARISER_API_KEY")
        or os.environ.get("OPENAI_SUMMARIZER_API_KEY")
        or os.environ.get("OPENAI_SUMMARISER_KEY")
        or os.environ.get("OPENAI_SUMMARIZER_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    )
    if not api_key:
        logging.warning(
            "OPENAI_API_KEY is not set; LLM calls will return empty responses."
        )
        return

    try:
        # Modern SDK
        from openai import OpenAI  # type: ignore

        _client_v1 = OpenAI(api_key=api_key)
        _is_v1 = True
    except Exception:
        # Legacy fallback
        try:
            import openai  # type: ignore

            openai.api_key = api_key
            _legacy_openai = openai
            _is_v1 = False
        except Exception as e:
            raise RuntimeError(
                "Failed to import OpenAI SDK. Ensure 'openai>=1.30.0,<2' is installed."
            ) from e


# Initialize on import so callers can fail fast
_init_client()


def chat_complete(
    model: str,
    messages: List[Dict[str, str]],
    *,
    max_completion_tokens: int = 800,
    temperature: float = 0.2,
    top_p: Optional[float] = None,
    timeout: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Minimal wrapper that returns the assistant's text content.
    Works with OpenAI SDK v1.x, and falls back to legacy if present.
    """
    if _client_v1 is None and _legacy_openai is None:
        return ""

    params = {
        "model": model,
        "messages": messages,
    }
    # o1, o3, and gpt-5 models do not accept a temperature parameter.
    _no_temp_prefixes = ("o1", "o3", "gpt-5")
    if temperature is not None and not any(model.startswith(p) for p in _no_temp_prefixes):
        params["temperature"] = temperature
    if _is_v1:
        params["max_completion_tokens"] = max_completion_tokens
    else:
        params["max_tokens"] = max_completion_tokens
    if top_p is not None:
        params["top_p"] = top_p
    if extra:
        params.update(extra)

    try:
        if _is_v1:
            resp = _client_v1.chat.completions.create(**params)  # type: ignore[attr-defined]
        else:
            resp = _legacy_openai.ChatCompletion.create(**params)  # type: ignore[union-attr]
    except Exception as e:
        # Retry without temperature if the model rejects it
        if "temperature" in str(e).lower():
            params.pop("temperature", None)
            if _is_v1:
                resp = _client_v1.chat.completions.create(**params)  # type: ignore[attr-defined]
            else:
                resp = _legacy_openai.ChatCompletion.create(**params)  # type: ignore[union-attr]
        else:
            raise
    return (
        (resp.choices[0].message.content or "").strip()
        if _is_v1
        else (resp["choices"][0]["message"]["content"] or "").strip()
    )


def count_prompt_tokens(messages: List[Dict[str, str]]) -> int:
    return _messages_to_token_count(messages)


def safe_chat(
    model: str,
    messages: List[Dict[str, str]],
    max_completion_tokens: int = 800,
    temperature: float = 0.2,
) -> str:
    """
    Convenience wrapper used by some older modules.
    """
    return chat_complete(
        model=model,
        messages=messages,
        max_completion_tokens=max_completion_tokens,
        temperature=temperature,
    )
