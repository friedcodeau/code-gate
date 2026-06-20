const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

const buildOptions = {
  bundle: true,
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV !== 'production',
  outdir: 'dist',
  platform: 'node',
  external: ['vscode'],
  format: 'cjs',
  plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
  if (test) {
    // Bundle the pure-logic unit tests into a runnable Node script.
    await esbuild.build({
      ...buildOptions,
      entryPoints: ['server/src/checks.test.ts'],
      outfile: 'dist/checks.test.js',
      outdir: undefined,
      minify: false,
      sourcemap: false,
      plugins: [],
    });
    return;
  }

  const clientContext = await esbuild.context({
    ...buildOptions,
    entryPoints: ['client/src/extension.ts'],
    outfile: 'dist/client.js',
    outdir: undefined,
  });

  const serverContext = await esbuild.context({
    ...buildOptions,
    entryPoints: ['server/src/server.ts'],
    outfile: 'dist/server.js',
    outdir: undefined,
  });

  // Headless CLI for CI / pre-commit gating. The shebang makes dist/cli.js
  // directly executable (used by the package's `bin` entry).
  const cliContext = await esbuild.context({
    ...buildOptions,
    entryPoints: ['server/src/cli.ts'],
    outfile: 'dist/cli.js',
    outdir: undefined,
    banner: { js: '#!/usr/bin/env node' },
  });

  if (watch) {
    await clientContext.watch();
    await serverContext.watch();
    await cliContext.watch();
  } else {
    await clientContext.rebuild();
    await serverContext.rebuild();
    await cliContext.rebuild();
    clientContext.dispose();
    serverContext.dispose();
    cliContext.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
