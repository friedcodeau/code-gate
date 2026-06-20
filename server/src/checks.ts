// Pure, dependency-free analysis helpers for the AI Quality Gate language server.
//
// Nothing in this file imports `vscode-languageserver`, so it can be unit-tested
// directly with Node (see checks.test.ts). The server (server.ts) wires these
// results into LSP Diagnostics.

export interface SecretFinding {
  /** Character offset (inclusive) where the match starts. */
  start: number;
  /** Character offset (exclusive) where the match ends. */
  end: number;
  message: string;
}

export interface RepetitionFinding {
  /** 0-based first line of the repeated run. */
  startLine: number;
  /** 0-based last line of the repeated run. */
  endLine: number;
  message: string;
}

interface SecretPattern {
  name: string;
  re: RegExp;
}

// Conservative, well-known credential shapes. Kept specific to avoid flagging
// ordinary identifiers as secrets.
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'OpenAI key', re: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

/** Scan text for hardcoded credentials. */
export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `AI Quality Gate: Possible hardcoded secret (${name}). Do not commit AI-generated credentials — move it to an environment variable.`,
      });
      // Guard against a zero-width match causing an infinite loop.
      if (m[0].length === 0) {
        re.lastIndex++;
      }
    }
  }
  return findings;
}

/**
 * Detect runs of identical non-empty lines as a proxy for "hallucination
 * loops" (a model repeating itself). A run of `threshold` or more identical
 * lines is reported once, spanning the whole run.
 */
export function scanRepetition(text: string, threshold = 3): RepetitionFinding[] {
  const findings: RepetitionFinding[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const current = lines[i].trim();
    if (current === '') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === current) {
      j++;
    }
    const run = j - i;
    if (run >= threshold) {
      findings.push({
        startLine: i,
        endLine: j - 1,
        message: `AI Quality Gate: Potential hallucination loop — identical line repeated ${run} times.`,
      });
    }
    i = j;
  }
  return findings;
}

export type FindingCode = 'secret' | 'repetition' | 'llm';

/**
 * A unified finding shape shared by every consumer (the LSP server and the CLI).
 * Lines and characters are 0-based, matching LSP; the CLI converts to 1-based
 * for human/SARIF output.
 */
export interface Finding {
  severity: number; // 1 = Error, 2 = Warning, 3 = Info
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  message: string;
  code: FindingCode;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; char: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let line = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      line = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { line, char: offset - lineStarts[line] };
}

/**
 * Run all deterministic local checks and return unified findings. This is the
 * single source of truth for the editor extension and the CLI gate, so both
 * surface identical results.
 */
export function collectLocalFindings(text: string): Finding[] {
  const lineStarts = computeLineStarts(text);
  const lines = text.split('\n');
  const findings: Finding[] = [];

  for (const s of scanSecrets(text)) {
    const start = offsetToPosition(lineStarts, s.start);
    const end = offsetToPosition(lineStarts, s.end);
    findings.push({
      severity: 1,
      startLine: start.line,
      startChar: start.char,
      endLine: end.line,
      endChar: end.char,
      message: s.message,
      code: 'secret',
    });
  }

  for (const r of scanRepetition(text)) {
    findings.push({
      severity: 2,
      startLine: r.startLine,
      startChar: 0,
      endLine: r.endLine,
      endChar: (lines[r.endLine] ?? '').length,
      message: r.message,
      code: 'repetition',
    });
  }

  return findings;
}

/**
 * Compute the set of 0-based line indices in `current` that are new relative to
 * `baseline`. Uses a content multiset rather than positional comparison so that
 * inserting a block doesn't mark everything after it as "changed". This is the
 * basis of the `changedLines` audit mode — it lets the gate focus on freshly
 * introduced (e.g. AI-pasted) code instead of the whole file.
 */
export function computeChangedLines(baseline: string, current: string): Set<number> {
  const changed = new Set<number>();
  const baseCounts = new Map<string, number>();
  for (const line of baseline.split('\n')) {
    const key = line.trim();
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }
  const currentLines = current.split('\n');
  for (let i = 0; i < currentLines.length; i++) {
    const key = currentLines[i].trim();
    if (key === '') {
      continue;
    }
    const remaining = baseCounts.get(key) ?? 0;
    if (remaining > 0) {
      baseCounts.set(key, remaining - 1);
    } else {
      changed.add(i);
    }
  }
  return changed;
}

/**
 * Convert a `file://` document URI to a filesystem path. Returns `undefined`
 * for non-file URIs (e.g. untitled/in-memory documents), which have no path to
 * resolve against git.
 */
export function uriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') {
      return undefined;
    }
    let p = decodeURIComponent(parsed.pathname);
    // Windows drive paths arrive as "/C:/..." — strip the leading slash.
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    return undefined;
  }
}

export interface LlmFinding {
  severity: number;
  startLine: number;
  endLine: number;
  message: string;
}

/**
 * Parse the raw text response from an LLM into validated findings. The LLM is
 * prompted to return a JSON array of `{ severity, line, endLine, message }`
 * objects (1-based lines). This function:
 * - Strips markdown code fences if the model wraps its output
 * - Parses JSON
 * - Validates each entry, dropping malformed ones
 * - Converts 1-based line numbers to 0-based and clamps to `[0, lineCount)`
 */
/**
 * Coerce a parsed LLM response into the findings array. Accepts a bare array,
 * or an object that wraps the array under a common key (or any array-valued
 * property) — some providers and JSON response modes wrap output in an object.
 */
function toFindingArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['findings', 'results', 'issues', 'diagnostics']) {
      if (Array.isArray(obj[key])) {
        return obj[key] as unknown[];
      }
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return undefined;
}

export function parseLlmFindings(rawText: string, lineCount: number): LlmFinding[] {
  const stripped = rawText
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  let arr: unknown[];
  try {
    const parsed = JSON.parse(stripped);
    const extracted = toFindingArray(parsed);
    if (!extracted) {
      return [];
    }
    arr = extracted;
  } catch {
    return [];
  }

  const findings: LlmFinding[] = [];
  const maxLine = Math.max(0, lineCount - 1);
  const clamp = (n: unknown) => Math.max(0, Math.min(maxLine, Math.floor(Number(n) || 1) - 1));

  for (const item of arr) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.message !== 'string' || !entry.message) {
      continue;
    }
    const sev = [1, 2, 3, 4].includes(entry.severity as number) ? (entry.severity as number) : 2;
    const startLine = clamp(entry.line);
    const endLine = entry.endLine != null ? clamp(entry.endLine) : startLine;

    findings.push({
      severity: sev,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      message: `[LLM Analysis] ${entry.message}`,
    });
  }
  return findings;
}
