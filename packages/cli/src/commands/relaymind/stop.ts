import { runVerb } from './lifecycle.js'

export default async function stop(argv: string[]): Promise<string> {
  return runVerb('stop', argv)
}
