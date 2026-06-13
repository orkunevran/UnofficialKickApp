"""Dedup-aware logging helpers to bound log volume from repeated failures.

A single exception logged with ``exc_info=True`` is typically 2–5 KB of
traceback. When such a log line fires every few seconds inside a long-lived
loop (background scan, retry path, circuit-breaker rejection), it can fill
disks within hours. These helpers collapse consecutive identical failures
into a single line plus periodic summary, and they never emit tracebacks
to stdout — the underlying root cause is captured once, not amplified.
"""

from __future__ import annotations

import logging
import threading


class ThrottledErrorLog:
    """Collapses consecutive identical exception signatures into one log line.

    The first occurrence of a (prefix, exception-type, message) tuple logs
    at WARNING. Subsequent identical occurrences are suppressed until either
    ``summary_every`` more have accumulated (then a single summary line is
    emitted) or a different signature appears (which resets the streak).
    """

    __slots__ = ("_lock", "_last_signature", "_streak", "_summary_every")

    def __init__(self, summary_every: int = 50) -> None:
        self._lock = threading.Lock()
        self._last_signature: str | None = None
        self._streak: int = 0
        self._summary_every: int = max(1, summary_every)

    def warn(self, log: logging.Logger, prefix: str, exc: BaseException) -> None:
        signature = f"{type(exc).__name__}: {exc}"
        with self._lock:
            if signature == self._last_signature:
                self._streak += 1
                if self._streak % self._summary_every == 0:
                    streak = self._streak
                    should_log_summary = True
                else:
                    should_log_summary = False
                emit_first = False
            else:
                self._last_signature = signature
                self._streak = 1
                emit_first = True
                should_log_summary = False
                streak = 0

        if emit_first:
            log.warning("%s: %s", prefix, signature)
        elif should_log_summary:
            log.warning("%s still failing (x%d): %s", prefix, streak, signature)


class RepeatSuppressingFilter(logging.Filter):
    """A ``logging.Filter`` that drops repeated identical log records.

    Designed for third-party libraries (pychromecast, zeroconf, urllib3…) that
    log inside their own retry loops with no backoff. A stuck reconnect can
    emit 25 tracebacks/sec — ~1.7 GB/day of pure spam. This filter passes the
    first occurrence of a (level, message-template) tuple, suppresses the next
    ``window_size`` repeats, and emits a single summary line every
    ``window_size`` events afterwards.

    Important: we key on (record.name, record.levelno, record.msg) — the
    *un-formatted* message template — so each unique error logs at least once.
    """

    __slots__ = ("_lock", "_window", "_last", "_streak")

    def __init__(self, window_size: int = 100) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._window = max(1, window_size)
        self._last: tuple[str, int, str] | None = None
        self._streak: int = 0

    def filter(self, record: logging.LogRecord) -> bool:
        signature = (record.name, record.levelno, str(record.msg))
        with self._lock:
            if signature == self._last:
                self._streak += 1
                if self._streak % self._window == 0:
                    # Rewrite the record to surface the streak count instead
                    # of emitting yet another identical line.
                    record.msg = f"{record.msg} [suppressed {self._streak} repeats]"
                    record.args = ()
                    record.exc_info = None
                    record.exc_text = None
                    return True
                return False
            # Different signature → flush state and let it through.
            self._last = signature
            self._streak = 1
        return True


class StateChangeLog:
    """Logs only when a boolean condition flips, not on every occurrence.

    Useful for circuit-breaker rejection paths: emit one line when the
    breaker opens, one line when it recovers, nothing in between.
    """

    __slots__ = ("_lock", "_state")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, bool] = {}

    def transitioned(self, key: str, condition: bool) -> bool:
        """Return True if ``condition`` differs from the previous call for ``key``."""
        with self._lock:
            prev = self._state.get(key)
            if prev == condition:
                return False
            self._state[key] = condition
            return True
