// Minimal, dependency-free unit tests for the pure analysis helpers.
// Run with: npm test
import {
  scanSecrets,
  scanRepetition,
  computeChangedLines,
  collectLocalFindings,
  parseLlmFindings,
  uriToPath
} from './checks';
import {
  parseArgs,
  countFailures,
  formatSarif,
  FileResult
} from './report';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// --- scanSecrets ---
assert(
  scanSecrets('const k = "sk-abcdefghijklmnopqrstuvwxyz0123456789";').length === 1,
  'scanSecrets flags an OpenAI-style key'
);
assert(
  scanSecrets('AKIAIOSFODNN7EXAMPLE').length === 1,
  'scanSecrets flags an AWS access key id'
);
assert(
  scanSecrets('const greeting = "hello world";').length === 0,
  'scanSecrets ignores ordinary strings'
);
{
  const f = scanSecrets('x = "sk-abcdefghijklmnopqrstuvwxyz0123456789"');
  assert(f[0].end > f[0].start, 'scanSecrets returns a non-empty range');
}

// --- scanRepetition ---
assert(
  scanRepetition('a\nfoo();\nfoo();\nfoo();\nb').length === 1,
  'scanRepetition flags a 3x repeated line'
);
{
  const f = scanRepetition('foo();\nfoo();\nfoo();\nfoo();');
  assert(f.length === 1 && f[0].startLine === 0 && f[0].endLine === 3, 'scanRepetition spans the whole run once');
}
assert(
  scanRepetition('foo();\nfoo();').length === 0,
  'scanRepetition ignores runs below threshold'
);
assert(
  scanRepetition('\n\n\n\n').length === 0,
  'scanRepetition ignores blank lines'
);
assert(
  scanRepetition('      }\n    }\n  }').length === 0,
  'scanRepetition does not flag nested closing braces at different indents'
);
assert(
  scanRepetition('    },\n    },\n    },').length === 0,
  'scanRepetition does not flag trivial punctuation lines (array-of-objects)'
);
assert(
  scanRepetition('  foo();\n    foo();\n      foo();').length === 0,
  'scanRepetition does not flag the same statement at different indentation'
);
assert(
  scanRepetition('    total += 1;\n    total += 1;\n    total += 1;').length === 1,
  'scanRepetition still flags a genuine repeated statement (same indent)'
);

// --- computeChangedLines ---
{
  const baseline = 'a\nb\nc';
  const current = 'a\nNEW\nb\nc';
  const changed = computeChangedLines(baseline, current);
  assert(changed.has(1) && changed.size === 1, 'computeChangedLines flags only the inserted line');
}
assert(
  computeChangedLines('a\nb', 'a\nb').size === 0,
  'computeChangedLines reports nothing for identical text'
);

// --- parseLlmFindings ---
{
  const json = JSON.stringify([
    { severity: 1, line: 5, endLine: 7, message: 'bug here' },
    { severity: 2, line: 3, message: 'warning' }
  ]);
  const f = parseLlmFindings(json, 20);
  assert(f.length === 2, 'parseLlmFindings parses valid JSON array');
  assert(f[0].startLine === 4 && f[0].endLine === 6, 'parseLlmFindings converts 1-based to 0-based lines');
  assert(f[1].endLine === f[1].startLine, 'parseLlmFindings defaults endLine to line when absent');
  assert(f[0].message.startsWith('[LLM Analysis]'), 'parseLlmFindings prefixes messages');
}
{
  const fenced = '```json\n[{"severity":2,"line":1,"message":"test"}]\n```';
  const f = parseLlmFindings(fenced, 10);
  assert(f.length === 1, 'parseLlmFindings strips markdown code fences');
}
{
  const outOfRange = JSON.stringify([
    { severity: 1, line: 999, endLine: 1000, message: 'far away' }
  ]);
  const f = parseLlmFindings(outOfRange, 10);
  assert(f[0].startLine === 9 && f[0].endLine === 9, 'parseLlmFindings clamps out-of-range lines');
}
assert(
  parseLlmFindings('not json at all', 10).length === 0,
  'parseLlmFindings handles non-JSON input'
);
assert(
  parseLlmFindings('{"object": true}', 10).length === 0,
  'parseLlmFindings handles non-array JSON'
);
assert(
  parseLlmFindings('{"findings":[{"severity":2,"line":1,"message":"wrapped"}]}', 10).length === 1,
  'parseLlmFindings unwraps an object-wrapped array (e.g. {"findings":[...]})'
);
{
  const mixed = JSON.stringify([
    { severity: 1, line: 1, message: 'valid' },
    { severity: 1, line: 1 },
    'not an object',
    null
  ]);
  const f = parseLlmFindings(mixed, 10);
  assert(f.length === 1, 'parseLlmFindings drops entries without message');
}
assert(
  parseLlmFindings('[]', 10).length === 0,
  'parseLlmFindings returns empty for empty array'
);
{
  const badSev = JSON.stringify([{ severity: 99, line: 1, message: 'bad' }]);
  const f = parseLlmFindings(badSev, 10);
  assert(f[0].severity === 2, 'parseLlmFindings defaults invalid severity to warning');
}

// --- uriToPath ---
assert(
  uriToPath('file:///Users/me/project/src/app.ts') === '/Users/me/project/src/app.ts',
  'uriToPath resolves a plain file URI'
);
assert(
  uriToPath('file:///Users/me/a%20b/app.ts') === '/Users/me/a b/app.ts',
  'uriToPath decodes percent-encoded path segments'
);
assert(
  uriToPath('untitled:Untitled-1') === undefined,
  'uriToPath returns undefined for non-file URIs'
);
assert(
  uriToPath('file:///C:/Users/me/app.ts') === 'C:/Users/me/app.ts',
  'uriToPath strips the leading slash on Windows drive paths'
);

// --- collectLocalFindings ---
{
  const text = 'line one\nline two\nconst k = "sk-abcdefghijklmnopqrstuvwxyz0123456789";';
  const f = collectLocalFindings(text);
  const secret = f.find(x => x.code === 'secret');
  assert(secret !== undefined && secret.startLine === 2, 'collectLocalFindings reports secret on the correct 0-based line');
  assert(secret !== undefined && secret.severity === 1, 'collectLocalFindings marks secrets as errors');
}
{
  const f = collectLocalFindings('foo();\nfoo();\nfoo();');
  assert(f.length === 1 && f[0].code === 'repetition' && f[0].severity === 2, 'collectLocalFindings reports repetition as warning');
}
assert(
  collectLocalFindings('const x = 1;').length === 0,
  'collectLocalFindings returns nothing for clean code'
);

// --- parseArgs ---
{
  const o = parseArgs(['--base', 'origin/main', '--format', 'json', '--llm', 'src/a.ts']);
  assert(o.base === 'origin/main', 'parseArgs reads --base value');
  assert(o.format === 'json', 'parseArgs reads --format value');
  assert(o.llm === true, 'parseArgs reads --llm flag');
  assert(o.files.length === 1 && o.files[0] === 'src/a.ts', 'parseArgs collects positional files');
}
assert(parseArgs([]).failOn === 'error', 'parseArgs defaults fail-on to error');
{
  let threw = false;
  try { parseArgs(['--format', 'xml']); } catch { threw = true; }
  assert(threw, 'parseArgs rejects an invalid --format');
}
{
  let threw = false;
  try { parseArgs(['--bogus']); } catch { threw = true; }
  assert(threw, 'parseArgs rejects an unknown flag');
}

// --- countFailures ---
{
  const results: FileResult[] = [{
    file: 'a.ts',
    findings: [
      { severity: 1, startLine: 0, startChar: 0, endLine: 0, endChar: 1, message: 'e', code: 'secret' },
      { severity: 2, startLine: 1, startChar: 0, endLine: 1, endChar: 1, message: 'w', code: 'repetition' },
      { severity: 3, startLine: 2, startChar: 0, endLine: 2, endChar: 1, message: 'i', code: 'llm' }
    ]
  }];
  assert(countFailures(results, 'error') === 1, 'countFailures: fail-on error counts only errors');
  assert(countFailures(results, 'warning') === 2, 'countFailures: fail-on warning counts errors + warnings');
  assert(countFailures(results, 'info') === 3, 'countFailures: fail-on info counts everything');
  assert(countFailures(results, 'never') === 0, 'countFailures: fail-on never counts nothing');
}

// --- formatSarif ---
{
  const results: FileResult[] = [{
    file: 'src/app.ts',
    findings: [{ severity: 1, startLine: 4, startChar: 2, endLine: 4, endChar: 9, message: 'boom', code: 'secret' }]
  }];
  const sarif = JSON.parse(formatSarif(results));
  assert(sarif.version === '2.1.0', 'formatSarif emits SARIF 2.1.0');
  const r = sarif.runs[0].results[0];
  assert(r.level === 'error', 'formatSarif maps severity 1 to error');
  assert(r.locations[0].physicalLocation.region.startLine === 5, 'formatSarif emits 1-based line numbers');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
