import threading
import time


class CircuitBreaker:
    """Lightweight circuit breaker for upstream API calls.

    States:
      CLOSED   – normal operation, requests pass through.
      OPEN     – too many failures, requests fail-fast with CircuitOpenError.
      HALF_OPEN – recovery probe: exactly ONE request is allowed through.
                  If it succeeds → CLOSED. If it fails → OPEN again.

    Thread safety:
      All state reads and transitions happen under a single Lock acquisition
      inside ``allow_request``, ``record_success``, and ``record_failure``.
      The half-open state permits only one probe via the ``_half_open_permitted``
      flag, which is set to False atomically when the first probe is granted.
    """

    def __init__(self, failure_threshold: int = 5, recovery_timeout: int = 30):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._failure_count = 0
        self._state = "closed"
        self._last_failure_time: float = 0.0
        self._half_open_permitted = False
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        with self._lock:
            self._maybe_transition_to_half_open()
            return self._state

    def _maybe_transition_to_half_open(self):
        """Transition open → half_open if recovery timeout elapsed. Must be called under lock."""
        if self._state == "open":
            if (time.monotonic() - self._last_failure_time) >= self.recovery_timeout:
                self._state = "half_open"
                self._half_open_permitted = True

    def allow_request(self) -> bool:
        """Atomically check if a request should be allowed through.

        In half-open state, only the first caller gets True (the probe).
        Subsequent callers see half-open but ``_half_open_permitted`` is
        already False, so they are rejected until the probe resolves.
        """
        with self._lock:
            self._maybe_transition_to_half_open()
            if self._state == "closed":
                return True
            if self._state == "half_open" and self._half_open_permitted:
                self._half_open_permitted = False  # only one probe
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self._failure_count = 0
            self._state = "closed"

    def record_failure(self) -> None:
        with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.monotonic()
            if self._failure_count >= self.failure_threshold:
                self._state = "open"
                self._half_open_permitted = False

    def stats(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "failure_count": self._failure_count,
                "failure_threshold": self.failure_threshold,
                "recovery_timeout": self.recovery_timeout,
            }
