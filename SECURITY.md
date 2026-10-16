# Security policy

Overlink provides remote access to terminals, files, browser sessions, Windows input, and processes. Treat deployment as a privileged service.

## Before deploying

- Use only an authenticated HTTPS gateway that supplies **verified** owner identity. Do not trust client-supplied identity headers.
- Keep deployment secrets, pairing data, certificates, device files, and runtime credentials outside Git.
- Apply least-privilege device permissions. Require manual approval for destructive tasks, credentials, session export, and recovery actions.
- Do not expose any local agent port to the public internet.
- Avoid storing unredacted Codex sessions or secrets in the transfer queue. Transfer contents are not currently end-to-end encrypted.
- Keep the service to **one trusted owner** in its current design. Multi-tenant authentication and isolation have not been production-hardened.
- Review database backups, encryption-at-rest, audit retention, revocation, rate limits, and disaster recovery before use with sensitive information.

## Security reports

If you discover a vulnerability, avoid publishing exploit details or actual credentials in a public GitHub issue. Use GitHub's **Report a vulnerability** / private security-advisory mechanism for this repository when available.

## Scope

This is a developer preview. Passing automated tests does not constitute an independent security audit, penetration test, or certification.
