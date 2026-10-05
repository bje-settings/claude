// The comma-separated number lists that `sweep` and `rounds` take, and the
// check that each one is given once. `watch` has its own pairs, but the same
// repeat check.
import { type Envelope, ok, refused } from './lib/envelope.ts'

/**
 * The numbers a flag's value names, without repeats, or a refusal that names
 * what was wrong. An empty value is an empty list. A leading `#` on a number
 * is allowed, so `#12` is issue 12.
 *
 * The shape is asserted before conversion, rather than inferred from the
 * result: `Number.parseInt` reads "4x" as 4 and "" as NaN. A sweep that
 * quietly swept milestone 4 for someone who typed "4x" would answer a
 * question nobody asked.
 */
export const numberList = (value: string, flag: string, noun: string): Envelope<number[]> => {
  if (value === '') return ok([])
  const numbers: number[] = []
  for (const word of value.split(',')) {
    const trimmed = word.trim().replace(/^#/, '')
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      return refused(`${flag} takes ${noun} numbers, not "${word.trim()}"`)
    }
    const number = Number(trimmed)
    if (!numbers.includes(number)) numbers.push(number)
  }
  return ok(numbers)
}

/**
 * Whether the command line names `flag` more than once.
 *
 * `lib/args.ts` declares no repeatable option. `parseArgs` answers a
 * repeated one with its LAST value, and no complaint. So `--milestone 4
 * --milestone 5` would sweep milestone 5, and say nothing about the 4 the
 * caller also asked for.
 */
export const repeated = (argv: readonly string[], flag: string): boolean =>
  argv.filter((word) => word === flag || word.startsWith(`${flag}=`)).length > 1
