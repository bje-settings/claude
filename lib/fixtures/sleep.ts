// This file stays alive for the milliseconds named in argv[0], then it says
// it finished. Tests measure a bound against this child. With a bound below
// that number, the run must report `timedOut`. With a bound above that
// number, the same fixture must come back normally.
//
// `harness/fixtures/` has no child that sleeps. It is also outside this
// layer's allowed file set. So the three fixtures here live beside the
// suite that runs them (lib/process.test.ts).
const ms = Number(process.argv[2])
setTimeout(() => {
  process.stdout.write('finished\n')
}, ms)
