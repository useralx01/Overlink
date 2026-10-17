# Changelog

## 2026-10-17

- Add a dark-silver interlocking-chain logo for Overlink. Windows executable icons and the dashboard build now use the new mark.
- Replace direct PowerShell/command-file automatic startup with a Windows-subsystem launcher that creates console-free PowerShell children.
- Add per-user logon and five-minute scheduled recovery, preserving Windows Store package context where needed.
- Keep one controller, retry temporarily missing runtimes, and respect explicit stop/resume.
- Back up prior startup configuration and add isolated recovery and installed-startup regression checks.

## 2026-10-16

- Publish the Overlink v0.4.1 developer-preview source, including cross-PC transfers, Codex context handoffs, diagnostics and guarded process recovery.
- Preserve the preceding Relay source on the archive/relay-before-overlink-20261016 branch.
