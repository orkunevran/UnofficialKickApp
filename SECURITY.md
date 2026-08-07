# Security Policy

## Supported version

Security fixes are applied to the latest release on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use
GitHub's **Security → Report a vulnerability** flow for this repository. If
private vulnerability reporting is unavailable, contact the maintainer through
the email address listed on the GitHub profile and include only enough detail
to establish a private reporting channel.

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Reports will be acknowledged as soon as practical.

## Deployment responsibility

This application uses unofficial upstream endpoints and can control devices on
the local network. Operators should keep the service on a trusted LAN or VPN,
keep dependencies current, and avoid exposing port 8081 directly to the public
internet. For deployments outside a trusted LAN, enable Chromecast control
authentication with `CONTROL_AUTH_ENABLED=true` and configure `CONTROL_TOKEN`.
