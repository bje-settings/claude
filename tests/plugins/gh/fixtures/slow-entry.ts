// This file stands in for `scripts/gh.ts` in the one example that
// measures a real bound. It never answers, so the timer fires and the
// hook's timeout arm runs, instead of an injected result.
//
// This is a `.ts` fixture, not a JSON one, beside `lib/fixtures/`'s three.
// It exists for the same reason they do. The suite that needs it has no
// other place to put a program. `vitest.config.ts` excludes
// `**/fixtures/**` from both collection and coverage. This file is linted
// and type-checked, but never measured.
setTimeout(() => {
  process.stdout.write('outlived the bound\n')
}, 60_000)
