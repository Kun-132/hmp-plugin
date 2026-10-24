# Security

This plugin sends your Claude Code prompts and final answers to **your own** HMP instance. It holds no secrets in this repository.

- Report a vulnerability privately via GitHub's "Report a vulnerability" (Security tab). Do not open a public issue.
- Releases are published only from the `release` branch. Changes to `main` and `release` require the maintainer's review.
- What the plugin can do is fixed in its code: it can send events to and read client settings from your HMP, and run a headless Claude limited to the HMP extraction tools. The server can lower limits, never raise them.
