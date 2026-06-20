// Pure CLI helpers: argument parsing, exit-code logic, and output formatting.
// No filesystem or git access here, so everything is unit-testable.

import { Finding } from './checks';

export type OutputFormat = 'pretty' | 'json' | 'sarif';
export type FailLevel = 'error' | 'warning' | 'info' | 'never';

export interface CliOptions {
  files: string[];
  base: string | undefined;
  all: boolean;
  staged: boolean;
  llm: boolean;
  provider: string | undefined;
  model: string | undefined;
  format: OutputFormat;
  failOn: FailLevel;
  scanSecrets: boolean;
  help: boolean;
}

export interface FileResult {
  file: string;
  findings: Finding[];
}

const VALID_FORMATS: OutputFormat[] = ['pretty', 'json', 'sarif'];
const VALID_FAIL_LEVELS: FailLevel[] = ['error', 'warning', 'info', 'never'];

const SEVERITY_NAME: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info' };
const SARIF_LEVEL: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'note' };
// fail-on threshold: a finding counts as a failure when its severity number is
// <= the threshold (1 = error is the most severe).
const FAIL_THRESHOLD: Record<FailLevel, number> = { error: 1, warning: 2, info: 3, never: 0 };

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    files: [],
    base: undefined,
    all: false,
    staged: false,
    llm: false,
    provider: undefined,
    model: undefined,
    format: 'pretty',
    failOn: 'error',
    scanSecrets: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help': opts.help = true; break;
      case '--all': opts.all = true; break;
      case '--staged': opts.staged = true; break;
      case '--llm': opts.llm = true; break;
      case '--no-secrets': opts.scanSecrets = false; break;
      case '--base': opts.base = requireValue(argv, ++i, arg); break;
      case '--provider': opts.provider = requireValue(argv, ++i, arg); break;
      case '--model': opts.model = requireValue(argv, ++i, arg); break;
      case '--format': {
        const v = requireValue(argv, ++i, arg);
        if (!VALID_FORMATS.includes(v as OutputFormat)) {
          throw new Error(`Invalid --format "${v}". Expected one of: ${VALID_FORMATS.join(', ')}`);
        }
        opts.format = v as OutputFormat;
        break;
      }
      case '--fail-on': {
        const v = requireValue(argv, ++i, arg);
        if (!VALID_FAIL_LEVELS.includes(v as FailLevel)) {
          throw new Error(`Invalid --fail-on "${v}". Expected one of: ${VALID_FAIL_LEVELS.join(', ')}`);
        }
        opts.failOn = v as FailLevel;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        opts.files.push(arg);
    }
  }
  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Count findings that meet or exceed the fail-on threshold. */
export function countFailures(results: FileResult[], failOn: FailLevel): number {
  const threshold = FAIL_THRESHOLD[failOn];
  let count = 0;
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity <= threshold) {
        count++;
      }
    }
  }
  return count;
}

interface Summary {
  files: number;
  errors: number;
  warnings: number;
  info: number;
}

function summarize(results: FileResult[]): Summary {
  const summary: Summary = { files: results.length, errors: 0, warnings: 0, info: 0 };
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === 1) summary.errors++;
      else if (finding.severity === 2) summary.warnings++;
      else summary.info++;
    }
  }
  return summary;
}

export function formatPretty(results: FileResult[]): string {
  if (results.length === 0) {
    return 'AI Quality Gate: no findings. ✓';
  }
  const lines: string[] = [];
  for (const result of results) {
    for (const finding of result.findings) {
      const sev = (SEVERITY_NAME[finding.severity] ?? 'info').padEnd(7);
      const loc = `${result.file}:${finding.startLine + 1}:${finding.startChar + 1}`;
      lines.push(`  ${sev} ${finding.code.padEnd(10)} ${loc}  ${finding.message}`);
    }
  }
  const s = summarize(results);
  lines.push('');
  lines.push(`AI Quality Gate: ${s.errors} error(s), ${s.warnings} warning(s), ${s.info} info across ${s.files} file(s)`);
  return lines.join('\n');
}

export function formatJson(results: FileResult[]): string {
  return JSON.stringify({ summary: summarize(results), results }, null, 2);
}

export function formatSarif(results: FileResult[]): string {
  const sarifResults = results.flatMap(result =>
    result.findings.map(finding => ({
      ruleId: `ai-quality-gate/${finding.code}`,
      level: SARIF_LEVEL[finding.severity] ?? 'warning',
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: result.file },
            region: {
              startLine: finding.startLine + 1,
              startColumn: finding.startChar + 1,
              endLine: finding.endLine + 1,
            },
          },
        },
      ],
    }))
  );

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'AI Quality Gate',
            informationUri: 'https://github.com/friedcodeau/code-gate',
            rules: [],
          },
        },
        results: sarifResults,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

export const HELP_TEXT = `AI Quality Gate — audit AI-generated code in CI or pre-commit.

Usage:
  ai-quality-gate [options] [files...]

Target selection (when no files are given):
  (default)            Audit working-tree changes vs HEAD
  --staged             Audit staged changes (for pre-commit hooks)
  --base <ref>         Audit changes between merge-base(<ref>, HEAD) and HEAD (for CI/PR)

Options:
  --all                Audit entire files, not just changed lines
  --no-secrets         Skip hardcoded-secret scanning
  --llm                Enable the LLM semantic layer
                       (reads AI_QUALITY_GATE_API_KEY and --provider / AI_QUALITY_GATE_PROVIDER)
  --provider <name>    claude | openai | gemini
  --model <name>       Override the provider's default model
  --format <fmt>       pretty | json | sarif        (default: pretty)
  --fail-on <level>    error | warning | info | never (default: error)
  -h, --help           Show this help

Exit codes:
  0  No findings at or above the --fail-on threshold
  1  Findings met the --fail-on threshold (gate failed)
  2  Usage or runtime error

Environment:
  AI_QUALITY_GATE_API_KEY    API key for the LLM provider
  AI_QUALITY_GATE_PROVIDER   Default provider if --provider is omitted
  AI_QUALITY_GATE_ENDPOINT   Override the provider API URL`;
