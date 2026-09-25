// Prints the arguments it was given, as JSON, so a test can assert argv
// survived the process boundary exactly.
process.stdout.write(JSON.stringify(process.argv.slice(2)))
