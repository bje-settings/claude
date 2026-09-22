// Stands in for `scripts/gh.ts` in the one example that measures a real bound:
// it never answers, so the hook's timeout arm is reached by the timer firing
// rather than by an injected result.
//
// A `.ts` fixture rather than a JSON one, beside `lib/fixtures/`'s three for
// the same reason they are there: the suite that needs it has no other place
// to put a program. `vitest.config.ts` excludes `**/fixtures/**` from both
// collection and coverage, so it is linted and type-checked and never
// measured.
setTimeout(() => {
  process.stdout.write('outlived the bound\n')
}, 60_000)
