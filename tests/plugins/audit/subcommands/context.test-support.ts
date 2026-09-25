// `/audit:context` against real repositories, with `gh` injected (ADR 001).
// The command function is the only seam. Tests reach `refs.ts`, `discover.ts`
// and `report.ts` only through it, never directly. This proves the report a
// caller actually gets, not an intermediate shape nobody consumes.
//
// Every fixture repository is a directory under `fixtures/repos/`.
// `harness/git.ts` `importTree` copies it in and commits it. This undoes the
// two names a fixture cannot use for its own files: `_gitignore` and
// `<name>.fixture.md`.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutput, type OutputStream } from '#audit/lib/streams.ts'
import type { Report } from '#audit/report.ts'
import type { ContextEdges } from '#audit/subcommands/context.ts'
import type { Ref } from '#audit/types.ts'
import { createGhMock, type GhClient, type GhReplies } from '#harness/gh.ts'
import { createGitFixtures, type GitFixtures } from '#harness/git.ts'
import {
  type ChoiceAnswer,
  type Classification,
  createJevMock,
  type EvidenceNeed,
  type JevReplies,
  type JevSequences,
  type UnitKind,
} from '#harness/jev.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

export const REPOS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'repos',
)

/** stdout and stderr as strings, the way `sync.test-support.ts` captures them. */
export function capture() {
  const out: string[] = []
  const err: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })
  return {
    output: createOutput(stream(out), stream(err)),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

export interface Audited {
  readonly sandbox: Sandbox
  readonly git: GitFixtures
  readonly work: string
  readonly edges: ContextEdges
  stdout(): string
  stderr(): string
}

/** A repository holding fixture `name`, and the edges to audit it with.
 *
 *  `now` counts in whole milliseconds from zero. This makes `wallClockMs` a
 *  literal value a test can assert, not a duration it must tolerate.
 *  `createGh` answers from `replies`. An endpoint with no reply throws. This
 *  proves a fixture with no issue references never reaches `gh` at all. */
export function audited(
  name: string,
  replies: GhReplies = {},
  jev: JevReplies = {},
  sequences: JevSequences = {},
): Audited {
  const sandbox = createSandbox()
  const git = createGitFixtures(sandbox)
  const work = git.create(sandbox.join('r'))
  git.importTree(work, path.join(REPOS, name))
  const captured = capture()
  let tick = 0
  const edges: ContextEdges = {
    cwd: sandbox.path,
    env: sandbox.env,
    output: captured.output,
    createGh: (): GhClient => createGhMock(replies),
    createJev: () => createJevMock(jev, sequences),
    now: () => {
      tick += 1
      return tick
    },
  }
  return { sandbox, git, work, edges, stdout: captured.stdout, stderr: captured.stderr }
}

/** The same repository, with a key in the environment. This makes the model
 *  stages run. `createJev` answers from `jev`, or from `sequences` where a
 *  stage's calls must differ from each other. The key is never a real one:
 *  the mock answers, and `harness/sandbox.ts` swept the real variable out
 *  first. */
export function modelled(
  name: string,
  jev: JevReplies,
  replies: GhReplies = {},
  sequences: JevSequences = {},
): Audited {
  const audit = audited(name, replies, jev, sequences)
  audit.sandbox.env.TYPESAFE_API_KEY = 'test-key'
  return audit
}

/** A Choice answer that picked `choice` outright. */
export const picked = <T extends string>(choice: T, confidence = 1): ChoiceAnswer<T> => ({
  choice,
  probabilities: { [choice]: 1 } as Record<T, number>,
  confidence,
})

/** The JSON report `--json` wrote, parsed. */
export const reportOf = (stdout: string): Report => JSON.parse(stdout) as Report

/** A findings line that names one judgment and its confidence. Its ORDER
 *  within a section is what a ranked section means. */
export const isConfLine = (line: string): boolean => line.startsWith('  conf ')

/** The opaque blocks of one file, in document order. Indexed by file, not by
 *  position in the whole report. A fixture that grows another file then does
 *  not renumber every assertion. */
export const blocksIn = (report: Report, file: string) =>
  report.opaque.filter((block) => block.file === file)

/** The refs of the one unit whose text contains `text`. A fixture that grows
 *  a paragraph then does not renumber every assertion beside it. */
export const unitNaming = (report: Report, text: string): Ref[] | undefined =>
  report.units.find((unit) => unit.text.includes(text))?.refs

/** One unit's five judgments, with only what a test is about spelled out. The
 *  defaults are the quiet answers: a repository fact, not volatile, whole on
 *  its own, and one claim. */
export const classified = (unitId: string, over: Partial<Classification> = {}): Classification => ({
  unitId,
  kind: picked<UnitKind>('repo_fact'),
  volatile: 0,
  selfContained: 1,
  evidenceNeed: picked<EvidenceNeed>('file_contents'),
  multiAssertion: 0,
  ...over,
})
