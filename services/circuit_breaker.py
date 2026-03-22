import threading
import time


class CircuitBreaker:
    """Lightweight circuit breaker for upstream API calls.

    States:
      CLOSED   – normal operation, requests pass through.
      OPEN     – too many failures, requests fail-fast with CircuitOpenError.
      HALF_OPEN – recovery probe: one request allowed through to test upstream.
    """

    def __init__(self, failure_threshold: int = 5, recovery_timeout: int = 30):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._failure_count = 0
        self._state = "closed"
        self._last_failure_time: float = 0.0
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        with self._lock:
            if self._state == "open":
                if (time.monotonic() - self._last_failure_time) >= self.recovery_timeout:
                    self._state = "half_open"
            return self._state

    def allow_request(self) -> bool:
        """Check if a request should be allowed through."""
        current = self.state  # triggers open→half_open transition
        if current == "closed":
            return True
        if current == "half_open":
            return True  # allow probe request
        return False  # open — fail fast

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

    def stats(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "failure_count": self._failure_count,
                "failure_threshold": self.failure_threshold,
                "recovery_timeout": self.recovery_timeout,
            }
