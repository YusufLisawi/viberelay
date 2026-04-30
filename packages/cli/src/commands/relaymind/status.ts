import { runVerb } from './lifecycle.js'

export default async function status(argv: string[]): Promise<string> {
  return runVerb('status', argv)
}
