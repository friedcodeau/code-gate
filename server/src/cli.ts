// Headless CLI for CI / pre-commit gating. Reuses the exact same analysis logic
// as the editor extension (collectLocalFindings, computeChangedLines, callLlm)
// so the gate behaves identically in both places.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import { collectLocalFindings, computeChangedLines, Finding } from './checks';
import { callLlm, LlmProvider } from './llm';
import {
  parseArgs,
  CliOptions,
  FileResult,
  formatPretty,
  formatJson,
  formatSarif,
  countFailures,
  HELP_TEXT,
} from './report';

const AUDITABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
]);

function gitSafe(args: string[]): string | undefined {
  try {
    // stderr is ignored: a non-zero git exit (e.g. a new file absent from the
    // baseline ref) is expected and handled by returning undefined, so its
    // error text shouldn't pollute CI logs.
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function splitLines(out: string | undefined): string[] {
  return (out ?? '').split('\n').map(l => l.trim()).filter(Boolean);
}

/** Resolve which files to audit based on the selection flags. */
function resolveTargetFiles(opts: CliOptions): string[] {
  if (opts.files.length > 0) {
    return opts.files;
  }
  if (opts.staged) {
    return splitLines(gitSafe(['diff', '--name-only', '--cached', '--diff-filter=ACMR']));
  }
  if (opts.base) {
    return splitLines(gitSafe(['diff', '--name-only', '--diff-filter=ACMR', `${opts.base}...HEAD`]));
  }
  // Default: working-tree changes vs HEAD.
  return splitLines(gitSafe(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']));
}

/** The content to analyze for a file (index content in --staged mode, else disk). */
function readAuditContent(file: string, opts: CliOptions): string | undefined {
  if (opts.staged) {
    return gitSafe(['show', `:${file}`]);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The baseline content to diff against for line scoping, or undefined for new files. */
function readBaselineContent(file: string, opts: CliOptions): string | undefined {
  if (opts.staged) {
    return gitSafe(['show', `HEAD:./${file}`]);
  }
  if (opts.base) {
    const mergeBase = gitSafe(['merge-base', opts.base, 'HEAD'])?.trim();
    const ref = mergeBase || opts.base;
    return gitSafe(['show', `${ref}:./${file}`]);
  }
  return gitSafe(['show', `HEAD:./${file}`]);
}

function isAuditable(file: string): boolean {
  return AUDITABLE_EXTENSIONS.has(path.extname(file));
}

function findingIntersectsChanged(finding: Finding, changed: Set<number>): boolean {
  for (let line = finding.startLine; line <= finding.endLine; line++) {
    if (changed.has(line)) {
      return true;
    }
  }
  return false;
}

async function runLlmLayer(
  content: string,
  file: string,
  opts: CliOptions,
  lineCount: number
): Promise<Finding[]> {
  const provider = (opts.provider ?? process.env.AI_QUALITY_GATE_PROVIDER ?? 'none') as LlmProvider;
  const apiKey = process.env.AI_QUALITY_GATE_API_KEY ?? '';
  if (provider === 'none' || !apiKey) {
    return [];
  }
  const llmFindings = await callLlm(
    content,
    file,
    {
      provider,
      apiKey,
      endpointOverride: process.env.AI_QUALITY_GATE_ENDPOINT ?? '',
      model: opts.model ?? '',
    },
    lineCount,
    { info: () => {}, error: (m: string) => console.error(`[ai-quality-gate] ${m}`) }
  );
  return llmFindings.map(f => ({
    severity: f.severity,
    startLine: f.startLine,
    startChar: 0,
    endLine: f.endLine,
    endChar: Number.MAX_SAFE_INTEGER,
    message: f.message,
    code: 'llm' as const,
  }));
}

async function auditFile(file: string, opts: CliOptions): Promise<Finding[]> {
  const content = readAuditContent(file, opts);
  if (content === undefined) {
    return [];
  }

  let findings = collectLocalFindings(content);
  if (!opts.scanSecrets) {
    findings = findings.filter(f => f.code !== 'secret');
  }

  // Scope local findings to changed lines unless --all.
  if (!opts.all) {
    const baseline = readBaselineContent(file, opts);
    if (baseline !== undefined) {
      const changed = computeChangedLines(baseline, content);
      findings = changed.size === 0 ? [] : findings.filter(f => findingIntersectsChanged(f, changed));
    }
  }

  // LLM findings are file-level and intentionally not diff-scoped (matches the extension).
  if (opts.llm) {
    const llm = await runLlmLayer(content, file, opts, content.split('\n').length);
    findings = findings.concat(llm);
  }

  return findings;
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    console.error(`\n${HELP_TEXT}`);
    process.exit(2);
  }

  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const files = resolveTargetFiles(opts).filter(isAuditable);
  const results: FileResult[] = [];
  for (const file of files) {
    const findings = await auditFile(file, opts);
    if (findings.length > 0) {
      results.push({ file, findings });
    }
  }

  const output =
    opts.format === 'json' ? formatJson(results)
      : opts.format === 'sarif' ? formatSarif(results)
        : formatPretty(results);
  console.log(output);

  const failures = countFailures(results, opts.failOn);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err?.message ?? String(err));
  process.exit(2);
});
