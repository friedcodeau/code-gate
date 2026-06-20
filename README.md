# AI Quality Gate

> Catch AI-generated "vibe coding" before it ships — audits your code for hardcoded
> secrets, hallucinated APIs, logic bugs, and security flaws, **in your editor and on
> every pull request.**

AI coding assistants write plausible-looking code fast — and quietly slip in leaked
secrets, calls to APIs that don't exist, off-by-one bugs, and security holes. **AI
Quality Gate** is a VS Code extension (and a matching CI/pre-commit CLI) that audits
that code as it lands and stops the bad parts from reaching your codebase.

The editor and the CLI share **one analysis engine**, so what you see while coding is
exactly what blocks a bad merge — the results never drift.

## Features

- 🔒 **Secret detection** — flags hardcoded credentials (OpenAI, GitHub, AWS, Slack,
  Google API keys, private-key blocks) with a one-click "move to env var" fix.
- 🔁 **Hallucination-loop detection** — flags runs of identical repeated lines.
- 🧠 **LLM semantic layer** — optionally sends parseable code to Claude, OpenAI, or
  Gemini to catch hallucinated APIs, logic errors, security vulnerabilities,
  over-engineering, dead code, and resource leaks.
- 🎯 **Diff-focused auditing** — scope findings to lines changed since you opened the
  file or to your git diff, so the gate targets *newly introduced* code.
- ✅ **CI / pre-commit gate** — the same checks run headlessly, exit non-zero on
  findings, and emit SARIF for inline GitHub PR annotations.
- ⚡ **Bring your own key** — no third-party server; the extension calls your chosen
  LLM provider directly.

Works on JavaScript / TypeScript and JSX / TSX.

> **Status:** early release (v0.0.1). The core engine is implemented and tested, with
> all three layers verified end-to-end.

## Install

**From source (packaged VSIX):**

```bash
git clone https://github.com/friedcodeau/code-gate.git
cd code-gate
npm install
npm run package          # produces ai-quality-gate-<version>.vsix
```

Then in VS Code: **Extensions → ⋯ → Install from VSIX…** and pick the generated file
(or `code --install-extension ai-quality-gate-0.0.1.vsix`).

Once published, it will also be installable from the Marketplace as
`friedcode.ai-quality-gate`.

## Quick start

1. Install the extension and open a JavaScript/TypeScript file — local findings appear
   as you type.
2. **(Optional) enable the LLM layer:** in VS Code settings, set
   `aiQualityGate.llmProvider` to `claude`, `openai`, or `gemini` and paste your key
   into `aiQualityGate.apiKey`.
3. **In CI**, gate pull requests with the bundled CLI (see
   [CI / pre-commit gate](#ci--pre-commit-gate)).

## How it works

Auditing happens in layered passes:

1. **Deterministic layer (local, fast)** — runs on every audit: secret detection and
   hallucination-loop detection. No network, no API key required.

2. **Semantic layer (LLM)** — when the code parses, the file is sent to your chosen
   provider (Claude, OpenAI, or Gemini). Responses are validated and clamped before
   being shown.

Findings appear as editor diagnostics with context-aware **Quick Fixes** (replace a
secret with an environment variable; collapse repeated lines). The same findings can be
scoped to changed lines only — see `auditMode` below.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `aiQualityGate.llmProvider` | `none` | Which LLM to use for semantic auditing: `claude`, `openai`, `gemini`, or `none` (local checks only). |
| `aiQualityGate.apiKey` | `""` | API key for the selected LLM provider. |
| `aiQualityGate.llmModel` | `""` | Override the default model. Defaults: Claude → `claude-sonnet-4-6`, OpenAI → `gpt-4o-mini`, Gemini → `gemini-2.0-flash`. |
| `aiQualityGate.cloudEndpoint` | `""` | Override the provider's API URL (for proxies or self-hosted endpoints). |
| `aiQualityGate.auditMode` | `fullDocument` | `fullDocument` audits everything; `changedLines` scopes local findings to lines changed since the file was opened or last saved; `gitDiff` scopes them to lines that differ from the committed git HEAD version (new/untracked files are audited in full). |
| `aiQualityGate.debounceMs` | `400` | Idle delay before auditing, to avoid auditing on every keystroke. |

## CI / pre-commit gate

The same checks run headlessly via the bundled CLI (`dist/cli.js`, exposed as the
`ai-quality-gate` bin). It audits a git diff and exits non-zero when findings meet the
`--fail-on` threshold, so it can gate a pull request or a commit.

```bash
ai-quality-gate                      # audit working-tree changes vs HEAD (default)
ai-quality-gate --staged             # audit staged changes (pre-commit)
ai-quality-gate --base origin/main   # audit what the branch added (CI/PR)
ai-quality-gate --all src/app.ts     # audit entire specified files
ai-quality-gate --base main --llm --provider claude --format sarif
```

By default only **changed lines** are gated (pre-existing issues on untouched lines are
ignored); pass `--all` to audit whole files. Run `ai-quality-gate --help` for every
flag. The LLM layer reads `AI_QUALITY_GATE_API_KEY` (and `AI_QUALITY_GATE_PROVIDER` /
`AI_QUALITY_GATE_ENDPOINT`) from the environment.

**GitHub Actions** — fail the build and surface findings as inline PR annotations via
SARIF:

```yaml
name: AI Quality Gate
on: pull_request
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # needed so the base ref is available for diffing
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx ai-quality-gate --base origin/${{ github.base_ref }} --format sarif > results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
```

### Pre-commit hook

Block commits that introduce issues. A ready-made hook lives at
[`samples/pre-commit`](samples/pre-commit):

```bash
cp samples/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

It runs `ai-quality-gate --staged` and aborts the commit on any error-level finding
(bypass once with `git commit --no-verify`).

## Development

```bash
npm install
npm run compile      # one-off build into dist/
npm run watch        # rebuild on change
npm test             # run the unit tests for the analysis helpers
npm run package      # build a publishable .vsix
```

Press **F5** (Launch Extension) to run the extension in a VS Code Extension Host. To
exercise the LLM layer, set `aiQualityGate.llmProvider` to your provider and paste your
API key into `aiQualityGate.apiKey` in VS Code settings.

## Architecture

- [`client/src/extension.ts`](client/src/extension.ts) — thin LSP client; boots the server.
- [`server/src/server.ts`](server/src/server.ts) — LSP server: debounced auditing, LLM dispatch, quick fixes.
- [`server/src/cli.ts`](server/src/cli.ts) — headless CI / pre-commit gate (git diff + exit codes).
- [`server/src/checks.ts`](server/src/checks.ts) — pure, dependency-free analysis helpers, incl. the shared `collectLocalFindings` (unit-tested).
- [`server/src/report.ts`](server/src/report.ts) — pure CLI arg parsing, exit-code logic, and output formatting (pretty/json/sarif).
- [`server/src/llm.ts`](server/src/llm.ts) — LLM provider integration (Claude, OpenAI, Gemini).
- [`cloud-backend-mock/`](cloud-backend-mock/) — Express mock for development (legacy, pre-LLM integration).

## License

[MIT](LICENSE) © Fried Code
