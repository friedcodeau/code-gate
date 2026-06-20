import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
  InitializeResult,
  CodeAction,
  CodeActionKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { execFile } from 'child_process';
import { parse } from '@typescript-eslint/typescript-estree';
import {
  collectLocalFindings,
  computeChangedLines,
  uriToPath,
  LlmFinding
} from './checks';
import { callLlm, LlmProvider } from './llm';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );

  const result: InitializeResult = {
    capabilities: {
      // Ask the client to send open/close/save so we can track a per-document
      // baseline for `changedLines` audit mode.
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: true }
      },
      codeActionProvider: true,
    }
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

type AuditMode = 'fullDocument' | 'changedLines' | 'gitDiff';

interface GateSettings {
  llmProvider: LlmProvider;
  apiKey: string;
  llmModel: string;
  cloudEndpoint: string;
  auditMode: AuditMode;
  debounceMs: number;
}

const defaultSettings: GateSettings = {
  llmProvider: 'none',
  apiKey: '',
  llmModel: '',
  cloudEndpoint: '',
  auditMode: 'fullDocument',
  debounceMs: 400
};
let globalSettings: GateSettings = defaultSettings;

// Per-document caches.
const documentSettings: Map<string, Thenable<GateSettings>> = new Map();
// Baseline text captured at open / last save, used to scope `changedLines` audits.
const documentBaselines: Map<string, string> = new Map();
// Pending debounce timers, keyed by document URI.
const pendingValidations: Map<string, ReturnType<typeof setTimeout>> = new Map();

const GIT_TIMEOUT_MS = 3000;
// HEAD content changes only on commit/checkout, so a short cache avoids
// spawning git on every debounced audit during continuous editing.
const GIT_CACHE_TTL_MS = 5000;
const gitHeadCache: Map<string, { content: string | undefined; expires: number }> = new Map();

/**
 * Return the committed (HEAD) content of the file behind `uri`, or `undefined`
 * if it can't be resolved — untracked/new file, not a git repo, no git binary,
 * or a non-file URI. An `undefined` baseline means "audit the whole document".
 */
function getGitHeadContent(uri: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = gitHeadCache.get(uri);
  if (cached && cached.expires > now) {
    return Promise.resolve(cached.content);
  }
  const filePath = uriToPath(uri);
  if (!filePath) {
    return Promise.resolve(undefined);
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return new Promise((resolve) => {
    // `HEAD:./<base>` resolves the path relative to `dir` (the repo subdir),
    // so this works regardless of where the file sits in the tree.
    execFile(
      'git',
      ['-C', dir, 'show', `HEAD:./${base}`],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout) => {
        const content = error ? undefined : stdout;
        gitHeadCache.set(uri, { content, expires: Date.now() + GIT_CACHE_TTL_MS });
        resolve(content);
      }
    );
  });
}

connection.onDidChangeConfiguration(change => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings.
    documentSettings.clear();
  } else {
    globalSettings = normalizeSettings(change.settings?.aiQualityGate);
  }

  // Revalidate all open text documents.
  documents.all().forEach(doc => scheduleValidation(doc));
});

const VALID_PROVIDERS: LlmProvider[] = ['claude', 'openai', 'gemini', 'none'];

function normalizeSettings(raw: unknown): GateSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<GateSettings>;
  const debounceMs = Number(s.debounceMs);
  return {
    llmProvider: VALID_PROVIDERS.includes(s.llmProvider as LlmProvider)
      ? (s.llmProvider as LlmProvider)
      : defaultSettings.llmProvider,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : defaultSettings.apiKey,
    llmModel: typeof s.llmModel === 'string' ? s.llmModel : defaultSettings.llmModel,
    cloudEndpoint: typeof s.cloudEndpoint === 'string' ? s.cloudEndpoint : defaultSettings.cloudEndpoint,
    auditMode:
      s.auditMode === 'changedLines' ? 'changedLines'
        : s.auditMode === 'gitDiff' ? 'gitDiff'
          : 'fullDocument',
    debounceMs: Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : defaultSettings.debounceMs
  };
}

function getDocumentSettings(resource: string): Thenable<GateSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace
      .getConfiguration({ scopeUri: resource, section: 'aiQualityGate' })
      .then(normalizeSettings);
    documentSettings.set(resource, result);
  }
  return result;
}

// Capture a baseline when a document opens, then validate it.
documents.onDidOpen(e => {
  documentBaselines.set(e.document.uri, e.document.getText());
  scheduleValidation(e.document);
});

// Refresh the baseline on save — saved content is the new "known good" state.
documents.onDidSave(e => {
  documentBaselines.set(e.document.uri, e.document.getText());
});

// Re-validate (debounced) whenever the content changes.
documents.onDidChangeContent(change => {
  scheduleValidation(change.document);
});

// Clean up everything we cached for a document when it closes.
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
  documentBaselines.delete(e.document.uri);
  gitHeadCache.delete(e.document.uri);
  const timer = pendingValidations.get(e.document.uri);
  if (timer) {
    clearTimeout(timer);
    pendingValidations.delete(e.document.uri);
  }
  // Clear any diagnostics we previously published for this document.
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

async function scheduleValidation(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const uri = textDocument.uri;
  const existing = pendingValidations.get(uri);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    pendingValidations.delete(uri);
    // Re-fetch the live document; it may have changed or closed since scheduling.
    const current = documents.get(uri);
    if (current) {
      validateTextDocument(current).catch(err =>
        connection.console.error(`Validation error: ${err?.message ?? err}`)
      );
    }
  }, settings.debounceMs);
  pendingValidations.set(uri, timer);
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(textDocument.uri);
  const text = textDocument.getText();
  const lines = text.split('\n');
  const diagnostics: Diagnostic[] = [];

  // 1. Deterministic layer (local, fast) — always runs. Shared with the CLI gate
  //    via collectLocalFindings so the editor and CI surface identical findings.
  for (const f of collectLocalFindings(text)) {
    diagnostics.push({
      severity: f.severity as DiagnosticSeverity,
      range: {
        start: { line: f.startLine, character: f.startChar },
        end: { line: f.endLine, character: f.endChar }
      },
      message: f.message,
      source: 'ai-quality-gate',
      code: f.code
    });
  }

  // Resolve a diff baseline for scoping. `fullDocument` uses none; `changedLines`
  // diffs against the in-session open/save snapshot; `gitDiff` diffs against the
  // file's committed HEAD version.
  let baseline: string | undefined;
  if (settings.auditMode === 'changedLines') {
    baseline = documentBaselines.get(textDocument.uri);
  } else if (settings.auditMode === 'gitDiff') {
    baseline = await getGitHeadContent(textDocument.uri);
  }
  let localDiagnostics = applyAuditScope(diagnostics, baseline, text);

  // 2. Semantic layer (LLM) — only dispatched when the syntax parses, so the
  //    LLM receives analyzable code. LLM findings are file-level and are
  //    not diff-scoped.
  let parseable = true;
  try {
    parse(text, { jsx: true, loc: true, range: true });
  } catch {
    parseable = false;
  }

  if (parseable && settings.llmProvider !== 'none' && settings.apiKey) {
    const logger = {
      info: (msg: string) => connection.console.info(msg),
      error: (msg: string) => connection.console.error(msg),
    };
    const findings = await callLlm(
      text,
      textDocument.uri,
      {
        provider: settings.llmProvider,
        apiKey: settings.apiKey,
        endpointOverride: settings.cloudEndpoint,
        model: settings.llmModel,
      },
      lines.length,
      logger
    );
    for (const f of findings) {
      localDiagnostics.push(llmFindingToDiagnostic(f));
    }
  }

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: localDiagnostics });
}

function applyAuditScope(
  diagnostics: Diagnostic[],
  baseline: string | undefined,
  text: string
): Diagnostic[] {
  if (baseline === undefined) {
    // fullDocument mode, or no baseline available (e.g. a new/untracked file in
    // gitDiff mode) — don't suppress anything.
    return diagnostics;
  }
  const changed = computeChangedLines(baseline, text);
  if (changed.size === 0) {
    return [];
  }
  return diagnostics.filter(d => {
    for (let line = d.range.start.line; line <= d.range.end.line; line++) {
      if (changed.has(line)) {
        return true;
      }
    }
    return false;
  });
}

function llmFindingToDiagnostic(f: LlmFinding): Diagnostic {
  return {
    severity: f.severity as DiagnosticSeverity,
    range: {
      start: { line: f.startLine, character: 0 },
      end: { line: f.endLine, character: Number.MAX_SAFE_INTEGER },
    },
    message: f.message,
    source: 'ai-quality-gate',
    code: 'llm',
  };
}

// Register Code Action Provider — context-aware quick fixes per diagnostic.
connection.onCodeAction((params) => {
  const codeActions: CodeAction[] = [];
  const uri = params.textDocument.uri;
  const document = documents.get(uri);

  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'ai-quality-gate') {
      continue;
    }

    if (diagnostic.code === 'secret') {
      codeActions.push({
        title: 'AI Quality Gate: Replace hardcoded secret with an environment variable',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
          changes: {
            [uri]: [{ range: diagnostic.range, newText: 'process.env.YOUR_SECRET_KEY' }]
          }
        }
      });
    } else if (diagnostic.code === 'repetition' && document) {
      // Collapse the repeated run down to its first line.
      const firstLine = document.getText({
        start: { line: diagnostic.range.start.line, character: 0 },
        end: { line: diagnostic.range.start.line, character: Number.MAX_SAFE_INTEGER }
      });
      codeActions.push({
        title: 'AI Quality Gate: Remove repeated lines (keep one)',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [uri]: [{ range: diagnostic.range, newText: firstLine }]
          }
        }
      });
    }
  }

  return codeActions;
});

// Make the text document manager listen on the connection
// for open, change and close text document events.
documents.listen(connection);

// Listen on the connection.
connection.listen();
