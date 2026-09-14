// The vitest configuration for the TypeScript layer this port adds (ADR 002).
// Coverage is 100 on all four buckets, with 95 as the floor the enterprise
// Code Coverage ruleset holds every repository to and the number the gate
// itself never goes below; relief is exclusion by file name with a stated
// reason, never a lowered threshold.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tests/ holds this repository's own checks, beside their Python
    // originals until #138 retires those. harness/, lib/, scripts/ and
    // plugins/*/src are named now, empty until #124 (harness), #125 (root
    // lib) and the plugin ports land, so those issues do not have to edit
    // this file to add their own tests.
    include: [
      'tests/**/*.test.ts',
      'harness/**/*.test.ts',
      'lib/**/*.test.ts',
      'scripts/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
    ],
    // .claude/worktrees/ holds checkouts of this same repository (see the
    // worktree workflow): without this exclusion every test in the tree
    // would be collected twice, once from the root and once from whichever
    // worktree happens to exist when the suite runs.
    exclude: ['**/node_modules/**', '.claude/worktrees/**', '**/fixtures/**'],
    // A run that collects nothing is not a pass.
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      // The source set is named, not discovered (ADR 002): a coverage
      // configuration that finds its own inputs can find zero of them and
      // still report 100%.
      include: [
        'tests/**/*.ts',
        'harness/**/*.ts',
        'lib/**/*.ts',
        'scripts/**/*.ts',
        'plugins/*/src/**/*.ts',
      ],
      // Test files are test code: measuring them would let an unused test
      // helper move the number without any shipped or shared code changing.
      exclude: ['**/*.test.ts', '**/fixtures/**'],
      // vitest 4 dropped the `all` option: coverage-v8 now includes every
      // file matching `include` whenever the whole suite runs (a single-file
      // rerun is the only case it narrows), which is the same "a file with
      // no test at all still shows at 0%, rather than being dropped from the
      // report entirely" property `all: true` used to state explicitly.
      // json-summary is what the CI guard below reads to refuse a report
      // naming no files. cobertura feeds actions/upload-code-coverage for the
      // enterprise Code Coverage ruleset: the one divergence from the
      // SurveyMonkey/skills baseline, which has no such ruleset to feed.
      reporter: ['text', 'json-summary', 'cobertura'],
      reportsDirectory: 'coverage',
      // 100 on every bucket. 95 is the floor this number never goes below
      // (ADR 002, the enterprise Code Coverage ruleset's own threshold);
      // relief is exclusion by file name with a comment saying why, never a
      // lowered threshold, because a lowered number hides every other file's
      // regression behind the one file that earned the exception.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
