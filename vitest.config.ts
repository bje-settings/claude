// The vitest configuration (ADR 002).
// Coverage is 100 on all four buckets. The enterprise Code Coverage ruleset
// holds every repository to a floor of 95, and this gate never goes below
// that. Relief is exclusion by file name, with a stated reason. It is
// never a lowered threshold.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test lives under tests/, and no test lives in a plugin or in
    // lib/ (ADR 004). Claude Code copies a plugin's whole directory, and the
    // lib/ symlink, into each user's cache, so a test there would ship.
    // tests/repo/repo-layout.test.ts refuses a test file anywhere else.
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
      // No plugins/*/src/lib/** entry here, unlike test.exclude above.
      // coverage-v8 keys itself by the canonical (realpath) module URL that
      // node's ESM loader resolves a symlinked import to. So it already
      // reports each lib/ file once, at its real path, with no duplicate
      // entry to exclude. Confirmed on #126: the coverage summary was
      // identical whether or not this entry existed.
      exclude: ['**/*.test.ts', '**/fixtures/**'],
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
