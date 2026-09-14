// Prints the directory it was run from and the HOME it was given, so a test
// can assert that cwd and env reached the child.
process.stdout.write(`${process.cwd()}\n${process.env.HOME}\n`)
