/**
 * Matrix thread context helpers (pure functions, no SDK dependency)
 *
 * Extracted so tests can import them without needing matrix-bot-sdk installed.
 */

/**
 * Normalized context extracted from a Matrix room event.
 */
export interface MatrixEventContext {
  roomId: string
  sender: string
  text: string
  eventId: string
  /** Non-empty when this event is inside a m.thread relation */
  threadRootEventId: string
  /** The event ID to use as the thread root when replying */
  replyThreadRootId: string
  /** Session key: room:threadRootEventId (thread isolation) or room (per-room) */
  sessionId: string
  /** Idempotency key */
  dedupeId: string
}

/**
 * Extract the m.thread root event ID from event content, if present.
 * Returns empty string for non-threaded events.
 */
export function extractThreadRootId(event: any): string {
  const relatesTo = event?.content?.["m.relates_to"]
  if (relatesTo?.rel_type === "m.thread" && relatesTo?.event_id) {
    return relatesTo.event_id
  }
  return ""
}

/**
 * Resolve the thread root event ID.
 * If the event is in a thread, use the thread root. Otherwise use the event itself.
 */
export function resolveThreadRoot(threadRootEventId: string, eventId: string): string {
  return threadRootEventId || eventId
}

/**
 * Build the session key.
 * When threadIsolation is true: room:threadRootEventId (per-thread)
 * When false: room (per-room, old behavior)
 */
export function buildMatrixSessionId(
  roomId: string,
  replyThreadRootId: string,
  threadIsolation: boolean
): string {
  if (threadIsolation) {
    return `${roomId}:${replyThreadRootId}`
  }
  return roomId
}

/**
 * Normalize raw Matrix event fields into a consistent MatrixEventContext.
 */
export function normalizeMatrixEventContext(
  input: {
    roomId: string
    sender?: string
    text?: string
    eventId: string
    threadRootEventId?: string
  },
  threadIsolation: boolean
): MatrixEventContext {
  const roomId = input.roomId
  const eventId = input.eventId
  const threadRootEventId = input.threadRootEventId || ""
  const replyThreadRootId = resolveThreadRoot(threadRootEventId, eventId)

  return {
    roomId,
    sender: input.sender || "unknown",
    text: input.text || "",
    eventId,
    threadRootEventId,
    replyThreadRootId,
    sessionId: buildMatrixSessionId(roomId, replyThreadRootId, threadIsolation),
    dedupeId: eventId,
  }
}

/**
 * Build the m.relates_to content for a thread reply.
 * Includes m.in_reply_to fallback for clients that don't support threads.
 */
export function buildThreadRelation(threadRootEventId: string, lastEventId: string): object {
  return {
    rel_type: "m.thread",
    event_id: threadRootEventId,
    is_falling_back: true,
    "m.in_reply_to": {
      event_id: lastEventId,
    },
  }
}

/**
 * Returns true if a plain thread reply (no trigger, no mention) should be
 * considered for forwarding to the bot.
 */
export function shouldHandleThreadReply(input: {
  text: string
  threadRootEventId: string
  trigger: string
  botUserId: string
}): boolean {
  const text = input.text.trim()
  if (!text) return false
  if (!input.threadRootEventId) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()} `)) return false
  if (text.toLowerCase().startsWith(`${input.trigger.toLowerCase()}`)) return false
  if (text.includes(input.botUserId)) return false
  return true
}
