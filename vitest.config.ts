// The vitest configuration (ADR 002).
// Coverage is 100 on all four buckets. The enterprise Code Coverage ruleset
// holds every repository to a floor of 95, and this gate never goes below
// that. Relief is exclusion by file name, with a stated reason. It is
// never a lowered threshold.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS = path.join(ROOT, 'plugins')
// A `#<plugin>/lib/<file>` specifier names a plugin's copy of a lib/ file.
const COPY_SPECIFIER = /^#[^/]+\/lib\/(.+)$/

// Each plugin holds copies of the lib/ files it imports (ADR 006). Node then
// loads a copy and lib/ as two modules, each with its own classes. The
// harness throws the `GhError` of lib/, and a plugin tests for its own copy
// with `instanceof`. So in a test run, this plugin sends each import of a
// copy to the file in lib/. Every module then sees one lib/, as node saw it
// through the old symlink. `scripts/sync-lib.ts --check` proves that each
// copy is equal to lib/, and the spawned tests run the copies as they ship.
const oneLib: Plugin = {
  name: 'one-lib',
  enforce: 'pre',
  resolveId(source, importer) {
    const named = COPY_SPECIFIER.exec(source)?.[1]
    if (named !== undefined) return path.join(ROOT, 'lib', named)
    if (!source.startsWith('.') || importer === undefined) return null
    const target = path.resolve(path.dirname(importer), source)
    const [plugin, src, lib, ...file] = path.relative(PLUGINS, target).split(path.sep)
    const isCopy = plugin !== '..' && src === 'src' && lib === 'lib' && file.length > 0
    return isCopy ? path.join(ROOT, 'lib', ...file) : null
  },
}

export default defineConfig({
  plugins: [oneLib],
  test: {
    // Every test lives under tests/, and no test lives in a plugin or in
    // lib/ (ADR 004). Claude Code copies a plugin's whole directory into
    // each user's cache, so a test there would ship.
    // tests/repo/repo-layout.test.ts refuses a test file in any other place.
    include: ['tests/**/*.test.ts'],
    // .claude/worktrees/ holds checkouts of this same repository (see the
    // worktree workflow). Without this exclusion, every test in the tree
    // would be collected twice. It would run once from the root, and again
    // from whichever worktree exists when the suite runs.
    exclude: ['**/node_modules/**', '.claude/worktrees/**', '**/fixtures/**'],
    // A run that collects nothing is not a pass.
    passWithNoTests: false,
    // vitest's default is 5 s, and #127 adds the first tests that build real
    // repositories and start real children inside one test, with layer 2's
    // real `pnpm install` still to come. Measured under load, individual tests
    // in `tests/lib/git.test.ts` took 5008, 5020, 5189, 6334 and 6709 ms, so the
    // default turns a loaded runner into a red suite that names a timeout
    // rather than the assertion. 30 s is well clear of that and still fails a
    // test that has genuinely hung.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // The source set is named, not discovered (ADR 002): a coverage
      // configuration that finds its own inputs can find zero of them and
      // still report 100%.
      // Of tests/, only the repository checks' own helper module is measured.
      // The other files there are tests, their helpers and their fixtures.
      include: [
        'tests/repo/**/*.ts',
        'harness/**/*.ts',
        'lib/**/*.ts',
        'scripts/**/*.ts',
        'plugins/*/src/**/*.ts',
      ],
      // Test files are test code. If you measured them, an unused test
      // helper could move the number, even when no shipped or shared code
      // changes.
      //
      // plugins/*/src/lib/** holds copies of lib/ files (ADR 006). The
      // `one-lib` plugin above sends each test import of a copy to lib/, so
      // no test loads a copy, and each copy would show 0%. lib/ is measured
      // once, at lib/. `scripts/sync-lib.ts --check` proves each copy equal.
      exclude: ['**/*.test.ts', '**/fixtures/**', 'plugins/*/src/lib/**'],
      // vitest 4 dropped the `all` option. Now coverage-v8 includes every
      // file that matches `include`, whenever the whole suite runs. A
      // single-file rerun is the only case that narrows this. `all: true`
      // used to state this property explicitly. A file with no test at all
      // still shows at 0%. The report does not drop it entirely.
      // json-summary is what the CI guard below reads, to refuse a report
      // that names no files. cobertura feeds actions/upload-code-coverage
      // for the enterprise Code Coverage ruleset. This is the one
      // divergence from the SurveyMonkey/skills baseline, which has no
      // such ruleset to feed.
      reporter: ['text', 'json-summary', 'cobertura'],
      reportsDirectory: 'coverage',
      // 100 on every bucket. 95 is the floor this number never goes below
      // (ADR 002, the enterprise Code Coverage ruleset's own threshold).
      // Relief is exclusion by file name, with a comment that says why,
      // never a lowered threshold. A lowered number hides every other
      // file's regression behind the one file that earned the exception.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
