export interface LogEntry {
  id: number
  ts: number
  stream: 'stdout' | 'stderr'
  line: string
}

export class LogBuffer {
  private entries: LogEntry[] = []
  private nextId = 1
  private readonly capacity: number
  private stdoutTail = ''
  private stderrTail = ''

  constructor(capacity: number = 500) {
    this.capacity = capacity
  }

  ingest(stream: 'stdout' | 'stderr', chunk: string | Buffer) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const pending = stream === 'stdout' ? this.stdoutTail + text : this.stderrTail + text
    const parts = pending.split('\n')
    const tail = parts.pop() ?? ''
    if (stream === 'stdout') {
      this.stdoutTail = tail
    } else {
      this.stderrTail = tail
    }
    for (const line of parts) {
      if (line.length === 0) continue
      this.entries.push({ id: this.nextId++, ts: Date.now(), stream, line })
    }
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
  }

  recent(since?: number): { entries: LogEntry[], lastId: number } {
    const lastId = this.entries.length > 0 ? this.entries[this.entries.length - 1].id : 0
    if (since === undefined) return { entries: this.entries.slice(-200), lastId }
    return { entries: this.entries.filter((entry) => entry.id > since), lastId }
  }
}
