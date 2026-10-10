/**
 * A message with every local path taken out (a user's folders, an app's place: what the agent and
 * a take never see). `known` paths go whole first (spaces in them), then `file:` URLs, then any
 * absolute path, up to where it plainly ends (a bracket, a quote, a comma, a colon and a space, or
 * the words a message says after one: "isn't", "any more"). URLs are kept.
 */
export function withoutPaths(text: string, known: readonly string[] = []): string {
  let said = text
  for (const path of [...known].sort((a, b) => b.length - a.length)) {
    if (path.length > 1) said = said.split(path).join("<a local path>")
  }
  return said
    .replace(/file:\/\/\/[^\s'"()<>,]*/g, "<a local path>")
    .replace(
      /(?<![:\w/.>])(?:~\/|\/)(?=\S*\/)[^\n'"(),]*?(?=$|[\n'"(),]|: | isn't| any more| is | was )/g,
      "<a local path>",
    )
}
