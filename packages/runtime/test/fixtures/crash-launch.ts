// A Kiframe that launches a desktop app and is then killed (the test's crash): it prints the
// launch's sandbox and waits. Args: <workDir> <executable> <bundle> <readable> <fixture app>.
import { launchElectron } from "../../src/electron.ts"

const [workDir, executable, bundle, readable, app] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
]
const target = await launchElectron({
  executable,
  bundle,
  readable: [readable],
  workDir,
  allowUnconfined: true,
  appArgs: [app, "hidden"],
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
})
process.stdout.write(`${target.sandbox}\n`)
setInterval(() => undefined, 60_000)
