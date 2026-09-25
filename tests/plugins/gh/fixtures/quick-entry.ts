// This is the other half of the bounded-child example. It is an entry
// point that answers at once, so the same bound that fires above must not
// fire here. It writes one actionable line. The hook wraps that line.
process.stdout.write('a: would delete gone\n')
