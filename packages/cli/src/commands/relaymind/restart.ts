import { runVerb } from './lifecycle.js'

export default async function restart(argv: string[]): Promise<string> {
  return runVerb('restart', argv)
}
