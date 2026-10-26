# Contributing to the BetterOff CLI

[README](README.md) · [Agent guide](AGENTS.md) · [Security policy](SECURITY.md)

Use this guide to propose a change and run the repository checks. Report a vulnerability as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Contribution checks

Changes reach `main` only through squash-merged pull requests. A repository ruleset blocks force-pushes and deletion, requires signed commits and linear history, and requires the `check`, `analyze (javascript-typescript)`, `analyze (actions)`, `review`, and `osv-scan` checks to pass.

To run the `check` job locally, run these commands from the repository root with [Bun](https://bun.sh) 1.4.3 or later:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build && ./dist/betteroff --version
```

Tests use a fake API and never call BetterOff. CI also scans the full Git history with gitleaks; run `gitleaks git --redact --no-banner .` to check locally.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
