# ── Stage 1: Build dependencies ──────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/python-311 AS builder

USER 0
RUN dnf install -y gcc-c++ make && dnf clean all && rm -rf /var/cache/dnf

WORKDIR /build
COPY requirements.txt .
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
 && /opt/venv/bin/pip install --no-cache-dir dumb-init

# ── Stage 2: Runtime ─────────────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/python-311

LABEL org.opencontainers.image.title="Unofficial Kick App" \
      org.opencontainers.image.description="Self-hosted FastAPI proxy for Kick.com streams" \
      org.opencontainers.image.version="3.1.0" \
      org.opencontainers.image.source="https://github.com/orkunevran/UnofficialKickApp"

USER 0
RUN dnf install -y iputils && dnf clean all && rm -rf /var/cache/dnf

# Copy venv from builder (no gcc/make in runtime image)
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

ENV USER=appuser
RUN useradd -m ${USER}
WORKDIR /home/${USER}/app

COPY --chown=${USER} . .

USER ${USER}

EXPOSE 8081

# Use the dedicated liveness endpoint instead of a business endpoint.
# /health/live returns 200 if the process is running — no DB or upstream
# dependency, so it won't flap on transient Kick API failures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8081/health/live')" || exit 1

# Run a single ASGI worker so the Chromecast singleton stays in-process.
ENTRYPOINT ["dumb-init", "--"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "1"]
