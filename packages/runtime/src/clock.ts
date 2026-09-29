// The take's clock (SECRETS-DESIGN T1): epoch milliseconds that never run backwards (the process's
// monotonic clock, anchored to the wall clock when it started), so a read or an event is never
// "older" because the wall clock stepped back. Screencast frames carry the browser's wall clock:
// the same epoch, until the wall clock steps during a take.
export const now = (): number => performance.timeOrigin + performance.now()
