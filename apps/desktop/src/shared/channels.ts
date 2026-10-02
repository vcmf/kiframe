// The channel names alone (the sandboxed preload bundles these, not the contract's schemas).
// `ipc.ts` checks at compile time that they are exactly the contract's channels.

export const INVOKE_CHANNELS = [
  "app:status",
  "key:set",
  "key:clear",
  "project:create",
  "project:open",
  "project:close",
  "external:open",
  "chat:state",
  "chat:send",
  "chat:stop",
  "chat:answer",
] as const

export const EVENT_CHANNELS = ["status", "chat:item", "chat:running", "live:frame"] as const
