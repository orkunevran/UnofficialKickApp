FROM registry.access.redhat.com/ubi9/python-311

# 1) become root just for package install
USER 0

# 1) Install required system packages
# We use microdnf which is the package manager in UBI
# and install gcc-c++ and make which are equivalent to build-essential

RUN dnf install -y gcc-c++ make iputils \
 && dnf clean all && rm -rf /var/cache/dnf

# 2) Create application directory and a non-root user
ENV USER=appuser
RUN useradd -m ${USER}
WORKDIR /home/${USER}/app

# 3) Install dependencies as root
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4) Copy application code and set permissions
COPY --chown=${USER} . .

# 5) Switch to non-root user for security
USER ${USER}

EXPOSE 8081
# Run a single ASGI worker so the Chromecast singleton stays in-process.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8081", "--workers", "1"]
