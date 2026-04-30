import { runVerb } from './lifecycle.js'

export default async function send(argv: string[]): Promise<string> {
  return runVerb('send', argv)
}
