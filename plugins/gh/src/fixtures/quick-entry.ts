// The other half of the bounded-child example: an entry point that answers at
// once, so the same bound that fires above must not fire here. It writes one
// actionable line, which is what the hook wraps.
process.stdout.write('a: would delete gone\n')
