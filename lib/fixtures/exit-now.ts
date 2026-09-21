// Exits before reading anything. A large `stdin` written to this child fails
// with EPIPE, which is the arm `run`'s stdin error listener exists for.
process.exit(0)
