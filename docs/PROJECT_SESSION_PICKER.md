# Project and Session Picker

Design for selecting existing ACP sessions from chat.

## Goal

Allow a chat user to switch the current chat thread to an existing saved agent session.

This is not process attachment. The bridge does not connect to an already-running desktop UI process. It selects a persisted ACP session and resumes/loads it through the configured ACP backend.

For Ferrum, this maps cleanly to its JSONL session store and ACP session IDs.

## Scope

This feature is disabled by default. Enable it explicitly in `chat-bridge.json`:

```json
{
  "sessionPicker": {
    "enabled": true,
    "connectors": ["whatsapp"],
    "mirrorIntervalSeconds": 60
  }
}
```

If `connectors` is empty, every connector may use the picker. Prefer listing only the connectors where exposing saved paths/session history is acceptable.

The picker is connector-neutral. Triggered commands such as `!oc /p` work on any enabled connector. WhatsApp additionally accepts bare slash commands such as `/p` and `/m 2` when the picker is enabled, for faster mobile use.

MVP commands:

```text
/h
/p
/p <number>
/s
/s <number>
/m <number>
/m
/r
/d
```

No multi-agent support. The bridge talks only to its configured ACP backend.

No separate history command. Selecting a session with `/s <number>` loads the session and returns a short recent-history preview automatically.

`/m <number>` starts read-only mirror mode for a saved session. It checks every 60 seconds and sends an update only when conversational history changes. `/m` stops mirror mode.

`/r` reloads the currently bound session through ACP and shows the same short recent-history preview. This is useful after another owner has closed the session and the chat user wants a fresh overview.

`/d` detaches the chat thread from the current saved session without deleting that backend session.

## Definitions

Project means a working directory recorded by the ACP backend as `cwd`.

Session means one persisted ACP session under a `cwd`, with a session ID and title.

Example ACP session item from Ferrum:

```json
{
  "sessionId": "dcfff795-db0d-49b7-b19b-cb6afaea7861",
  "cwd": "/home/ominiverdi/codeberg/ferrum",
  "title": "ferrum-dev"
}
```

## User flow

List projects:

```text
/p
```

Response:

```text
Projects:
1. ferrum
   /home/ominiverdi/codeberg/ferrum
   121 sessions
2. opencode-chat-bridge
   /home/ominiverdi/github/archive/opencode/opencode-chat-bridge
   9 sessions
3. EcoCentral
   /home/ominiverdi/github/EcoCentral
   4 sessions

Use /p <number> to select a project.
```

Select project:

```text
/p 1
```

Response includes the session list immediately:

```text
Selected project: ferrum
/home/ominiverdi/codeberg/ferrum

Sessions in ferrum:
1. ferrum-dev
   dcfff795
2. hey ferrum
   c0427474

Use /s <number> to switch interactively.
Use /m <number> to mirror read-only.
```

List sessions for selected project again:

```text
/s
```

Response:

```text
Sessions in ferrum:
1. ferrum-dev
   dcfff795
2. hey ferrum
   c0427474
3. canary-newline-fix
   f41ad7d5
4. canary-acp-core-3eba230
   03fb0e1a
5. (empty session)
   c75c6746

Use /s <number> to switch interactively.
Use /m <number> to mirror read-only.
```

Select session:

```text
/s 2
```

Response:

```text
Attached to session: hey ferrum
Project: /home/ominiverdi/codeberg/ferrum
Session: c0427474-0410-48ee-af6f-e9392f8db64a

Recent history:
User: ...
Assistant: ...
User: ...
Assistant: ...
```

Future prompts in the same chat thread continue in that selected session.

## ACP calls

### `/p`

Call:

```text
session/list
```

with no `cwd` filter.

Follow pagination until there is no cursor.

Group results by `cwd`.

Display:

- project number
- `basename(cwd)` as label
- full `cwd`
- count of sessions for that `cwd`

Sort recommendation for MVP:

1. descending session count
2. then path alphabetically

A later version may sort by latest activity if the ACP backend exposes updated timestamps.

### `/p <number>`

Use the last `/p` result stored for this chat thread.

Persist selected project state:

```ts
{
  connector: string
  threadId: string
  selectedCwd: string
}
```

This can live alongside the current ACP session store or in an adjacent small state file.

### `/s`

Requires selected `cwd`. If no project is selected, tell the user to run `/p` first.

Call:

```text
session/list
```

with:

```json
{
  "cwd": "/selected/project/path"
}
```

Display numbered sessions:

- title
- short session ID

Keep output bounded. Show the first 10-20 sessions for MVP.

### `/s <number>`

Use the last `/s` result stored for this chat thread.

Call:

```text
session/load
```

with selected:

```json
{
  "sessionId": "...",
  "cwd": "/selected/project/path"
}
```

`session/load` is preferred over `session/resume` for explicit user selection because it replays persisted session updates. The bridge can use that replay to build the recent-history preview.

After successful load:

- disconnect any existing ACP client for this chat thread if needed
- bind this chat thread to the loaded ACP session
- update the bridge session store with `sessionId`, `cwd`, and `backendId`
- send the attach confirmation plus recent history

For automatic bridge restart restore, keep using `session/resume` so the bridge does not unexpectedly dump history into chat.

## Recent-history preview

When `/s <number>` calls `session/load`, the ACP backend replays stored `session/update` notifications before returning.

The bridge should collect replay updates into a small transcript buffer.

MVP preview rules:

- show last 5-6 conversational messages
- include user and assistant text
- omit or summarize tool calls/results
- truncate each item to a safe length, e.g. 500-800 chars
- cap total preview output, e.g. 4000-6000 chars

Example formatting:

```text
Recent history:
User: Can we add Codeberg MCP?
Assistant: Implemented and wired a read-only unauthenticated Codeberg MCP...
User: Can you add it to !oc also?
Assistant: Added Codeberg MCP to !oc and validated locally...
```

If no useful replayed text is available:

```text
Recent history: no conversational messages found.
```

## State and safety

The picker state is per chat thread, not global.

Needed transient state:

```ts
lastProjectList: Map<threadId, ProjectItem[]>
lastSessionList: Map<threadId, SessionItem[]>
```

Needed persisted state:

```ts
selectedCwd per connector/threadId
selected session binding per connector/threadId
```

The existing `ACPSessionStore` already stores:

```ts
connector
threadId
sessionId
cwd
backendId
updatedAt
```

It may be enough for the selected session binding. A small addition is needed for selected project when no session is selected yet.

Do not allow switching sessions while a prompt is active in that chat thread. Return:

```text
A request is still running in this thread. Wait for it to finish, then run /s <number> again.
```

## Mirror read-only

```text
/m <number>
```

Uses the last `/s` session list for the selected project. It starts read-only mirror mode for that saved session.

Behavior:

1. call `session/load` once to capture an initial snapshot
2. reply with mirror status plus a bounded current tail
3. poll every `sessionPicker.mirrorIntervalSeconds` seconds, default 60
4. call `session/load` on each poll
5. send a mirror update only when conversational/tool history changed
6. stop mirroring when `/m` is sent or when user activity is detected in the same chat thread

Mirror mode does not send prompts to the backend session.

```text
/m
```

Stops mirror mode.

## Reload current session

```text
/r
```

Uses the currently stored chat-thread session binding.

Behavior:

1. reject if a prompt is active in this chat thread
2. close and disconnect the current in-memory ACP session if one exists
3. call `session/load` for the stored `sessionId` and `cwd`
4. show recent history using the same preview rules as `/s <number>`
5. keep the chat thread bound to the same persisted backend session

If `session/load` fails due to replay limits, the bridge may try `session/resume` and report that recent history is unavailable.

## Command behavior

Unknown numbers:

```text
Unknown project number. Run /p again.
```

```text
Unknown session number. Run /s again.
```

No sessions:

```text
No saved sessions found for this project.
```

No projects:

```text
No saved ACP sessions found.
```

## Non-goals for MVP

Do not implement:

- attaching to arbitrary live desktop processes
- multi-agent selection
- a separate history command
- search/filter syntax
- deleting sessions from picker menus
- session previews before selection
- custom backend cache parsing

The bridge should use ACP, not Ferrum/OpenCode private cache formats.

## Future improvements

Possible later additions:

- `/p search <text>`
- `/s search <text>`
- latest-updated sorting if ACP exposes timestamps
- `/detach` to unbind without deleting the backend session
- configurable max projects/sessions shown
- include active/locked status if backend exposes it
- richer preview if ACP standardizes session metadata/history summaries
