# Security

If you discover a security issue, please avoid posting full exploit details in a public issue first.

Open a private channel with the maintainer if possible, or provide a minimal public report that does not leak sensitive reproduction details.

## Data Flow

- Feishu messages pass through Feishu
- Codex requests and responses pass through official Codex / OpenAI services
- This project does not add any extra third-party telemetry layer on top

## Safe Defaults

- Keep `ALLOWED_OPEN_IDS` restricted in real usage
- Keep `WORKSPACE_ROOTS` as small as possible
- Prefer `CODEX_CONTROL_SCOPE=workspace` for normal usage
- Treat `CODEX_CONTROL_SCOPE=computer` as an advanced mode
- Review every `/approve` action before allowing execution

## Sensitive Areas

- Feishu app credentials
- Codex account session state
- Workspace root permissions
- Approval bypasses
- Any path traversal or command execution edge case

## Release Hygiene

- Rotate Feishu secrets before public demos or GitHub release
- Do not commit `.env`, `data/`, or `logs/`
- Scrub screenshots, videos, and logs for personal paths and secrets
