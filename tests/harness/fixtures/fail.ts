// Writes to both streams and exits non-zero, which is the shape a command's
// failure contract has: a message on stderr, whatever it managed on stdout,
// and a status that is not 0.
process.stdout.write('partial\n')
process.stderr.write('boom\n')
process.exit(3)
