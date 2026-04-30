import { runVerb } from './lifecycle.js'

export default async function start(argv: string[]): Promise<string> {
  return runVerb('start', argv)
}
