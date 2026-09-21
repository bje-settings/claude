// Stays alive for the milliseconds named in argv[0], then says it finished.
// The child a bound is measured against: with a bound below that number the
// run must report `timedOut`, and with one above it the same fixture must
// come back normally.
//
// `harness/fixtures/` has no sleeping child and is outside this layer's
// allowed file set, so the three fixtures here live beside the suite that
// runs them (lib/process.test.ts).
const ms = Number(process.argv[2])
setTimeout(() => {
  process.stdout.write('finished\n')
}, ms)
