import { appendFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const LOG_DIR = join(homedir(), ".opencode")
const LOG_FILE = join(LOG_DIR, "memory-plugin.log")

/**
 * Append a log message synchronously to the memory-plugin log file.
 * Creates the parent directory if it does not exist.
 */
export function writeLog(message: string): void {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
}
