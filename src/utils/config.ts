/**
 * Configuration loading and validation utilities.
 */

import type { ChatBridgeConfig } from '../index'

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target }
  
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key]
    const targetValue = target[key]
    
    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T]
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T]
    }
  }
  
  return result
}

/**
 * Resolve environment variable references in a value
 * Supports: {env:VAR_NAME} and {env:VAR_NAME:default}
 */
export function resolveEnvVar(value: string): string {
  const envPattern = /\{env:(\w+)(?::([^}]*))?\}/g
  
  return value.replace(envPattern, (_, varName, defaultValue) => {
    const envValue = process.env[varName]
    if (envValue !== undefined) {
      return envValue
    }
    if (defaultValue !== undefined) {
      return defaultValue
    }
    console.warn(`Environment variable ${varName} not set and no default provided`)
    return ''
  })
}

/**
 * Recursively resolve environment variables in an object
 */
export function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    return resolveEnvVar(obj) as T
  }
  
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars) as T
  }
  
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value)
    }
    return result as T
  }
  
  return obj
}

/**
 * Validate required fields in config
 */
export function validateConfig(config: ChatBridgeConfig): string[] {
  const errors: string[] = []
  
  // Check Matrix config if enabled
  if (config.matrix?.enabled) {
    if (!config.matrix.homeserver) {
      errors.push('matrix.homeserver is required')
    }
    if (!config.matrix.userId) {
      errors.push('matrix.userId is required')
    }
    if (!config.matrix.accessToken) {
      errors.push('matrix.accessToken is required')
    }
  }
  
  // Check Discord config if enabled (future)
  if (config.discord?.enabled) {
    if (!config.discord.token) {
      errors.push('discord.token is required')
    }
  }
  
  return errors
}

/**
 * Get default configuration
 */
export function getDefaultConfig(): Partial<ChatBridgeConfig> {
  return {
    modes: {
      '!s': 'serious',
      '!d': 'sarcastic', 
      '!a': 'agent',
      '!p': 'plan',
    },
    defaultAgent: undefined,
    sessionStorePath: undefined,
  }
}
