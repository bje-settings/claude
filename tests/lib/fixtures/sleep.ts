// This file stays alive for the milliseconds named in argv[0], then it says
// it finished. Tests measure a bound against this child. With a bound below
// that number, the run must report `timedOut`. With a bound above that
// number, the same fixture must come back normally.
//
// `tests/harness/fixtures/` has no child that sleeps. It was also outside
// the allowed file set of the layer that added this file. So the fixtures
// here live beside the suite that runs them (`tests/lib/process.test.ts`).
const ms = Number(process.argv[2])
setTimeout(() => {
  process.stdout.write('finished\n')
}, ms)
