import { runVerb } from './lifecycle.js'

export default async function attach(argv: string[]): Promise<string> {
  return runVerb('attach', argv)
}
