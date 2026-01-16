/**
 * Simple logging utility with levels and prefixes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
}

function formatMessage(level: LogLevel, prefix: string, message: string): string {
  const timestamp = new Date().toISOString()
  return `${timestamp} [${level.toUpperCase()}] [${prefix}] ${message}`
}

export function createLogger(prefix: string) {
  return {
    debug(message: string, ...args: unknown[]): void {
      if (shouldLog('debug')) {
        console.debug(formatMessage('debug', prefix, message), ...args)
      }
    },

    info(message: string, ...args: unknown[]): void {
      if (shouldLog('info')) {
        console.info(formatMessage('info', prefix, message), ...args)
      }
    },

    warn(message: string, ...args: unknown[]): void {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', prefix, message), ...args)
      }
    },

    error(message: string, ...args: unknown[]): void {
      if (shouldLog('error')) {
        console.error(formatMessage('error', prefix, message), ...args)
      }
    },
  }
}

// Default logger
export const logger = createLogger('chat-bridge')
