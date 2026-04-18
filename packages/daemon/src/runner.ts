import process from 'node:process'
import { createDaemonController } from './index.js'

const controller = createDaemonController({ port: 8327 })

async function main() {
  const started = await controller.start()
  process.stdout.write(JSON.stringify(started) + '\n')
}

void main()

const shutdown = async () => {
  await controller.stop()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
