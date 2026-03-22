"""Tests for services/circuit_breaker.py — state machine transitions."""

import time
from unittest.mock import patch

from services.circuit_breaker import CircuitBreaker


class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)
        assert cb.state == "closed"
        assert cb.allow_request() is True

    def test_opens_after_threshold_failures(self):
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "closed"
        cb.record_failure()
        assert cb.state == "open"
        assert cb.allow_request() is False

    def test_success_resets_failure_count(self):
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        # After success, should be back to 0 failures
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "closed"

    def test_transitions_to_half_open_after_recovery(self):
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=1)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "open"

        # Simulate time passing beyond recovery timeout
        with patch("services.circuit_breaker.time") as mock_time:
            mock_time.monotonic.return_value = time.monotonic() + 2
            assert cb.state == "half_open"
            assert cb.allow_request() is True

    def test_half_open_success_closes(self):
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0)
        cb.record_failure()
        # Force half_open by checking state (recovery_timeout=0 means immediate)
        with patch("services.circuit_breaker.time") as mock_time:
            mock_time.monotonic.return_value = time.monotonic() + 1
            assert cb.state == "half_open"
        cb.record_success()
        assert cb.state == "closed"

    def test_stats(self):
        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=30)
        cb.record_failure()
        stats = cb.stats()
        assert stats["failure_count"] == 1
        assert stats["failure_threshold"] == 5
        assert stats["state"] == "closed"
