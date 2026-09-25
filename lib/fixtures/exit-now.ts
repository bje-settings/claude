// This file exits before it reads anything. A large `stdin` written to this
// child fails with EPIPE. This is the case that `run`'s stdin error listener
// exists for.
process.exit(0)
