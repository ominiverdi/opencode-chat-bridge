import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"

export interface StoredACPSession {
  connector: string
  threadId: string
  sessionId: string
  cwd: string
  backendId: string
  updatedAt: string
}

interface SessionStoreFile {
  version: 1
  sessions: StoredACPSession[]
}

const EMPTY_STORE: SessionStoreFile = { version: 1, sessions: [] }
const LOCK_RETRY_MS = 25
const LOCK_ATTEMPTS = 200
const STALE_LOCK_MS = 30_000

export class ACPSessionStore {
  readonly filePath: string
  private readonly lockPath: string

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath)
    this.lockPath = `${this.filePath}.lock`
  }

  get(connector: string, threadId: string): StoredACPSession | null {
    return this.read().sessions.find(
      (entry) => entry.connector === connector && entry.threadId === threadId,
    ) || null
  }

  async set(entry: StoredACPSession): Promise<void> {
    await this.withLock(() => {
      const store = this.read()
      store.sessions = store.sessions.filter(
        (candidate) => candidate.connector !== entry.connector || candidate.threadId !== entry.threadId,
      )
      store.sessions.push(entry)
      this.write(store)
    })
  }

  async delete(connector: string, threadId: string): Promise<void> {
    await this.withLock(() => {
      const store = this.read()
      store.sessions = store.sessions.filter(
        (entry) => entry.connector !== connector || entry.threadId !== threadId,
      )
      this.write(store)
    })
  }

  private read(): SessionStoreFile {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY_STORE, sessions: [] }

    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<SessionStoreFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error(`Invalid ACP session store: ${this.filePath}`)
    }

    for (const entry of parsed.sessions) {
      if (!entry || typeof entry !== "object" ||
          typeof entry.connector !== "string" ||
          typeof entry.threadId !== "string" ||
          typeof entry.sessionId !== "string" ||
          typeof entry.cwd !== "string" ||
          typeof entry.backendId !== "string" ||
          typeof entry.updatedAt !== "string") {
        throw new Error(`Invalid ACP session entry in: ${this.filePath}`)
      }
    }

    return { version: 1, sessions: parsed.sessions }
  }

  private write(store: SessionStoreFile): void {
    const parent = path.dirname(this.filePath)
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`

    try {
      fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.filePath)
      fs.chmodSync(this.filePath, 0o600)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }

  private async withLock(action: () => void): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      let lock: number | null = null
      try {
        lock = fs.openSync(this.lockPath, "wx", 0o600)
        action()
        return
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err
        this.removeStaleLock()
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      } finally {
        if (lock !== null) {
          fs.closeSync(lock)
          try {
            fs.unlinkSync(this.lockPath)
          } catch (err: any) {
            if (err?.code !== "ENOENT") throw err
          }
        }
      }
    }

    throw new Error(`Timed out locking ACP session store: ${this.filePath}`)
  }

  private removeStaleLock(): void {
    try {
      const age = Date.now() - fs.statSync(this.lockPath).mtimeMs
      if (age > STALE_LOCK_MS) fs.unlinkSync(this.lockPath)
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err
    }
  }
}
