// A Kiframe that launches a desktop app and is then killed (the test's crash): it prints the
// launch's sandbox and waits. Args: <workDir> <executable> <bundle> <readable> <fixture app>.
import { launchElectronWith } from "../../src/electron.ts"

const [workDir, executable, bundle, readable, app] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
]
const target = await launchElectronWith(
  {
    executable,
    bundle,
    workDir,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  },
  { readable: [readable], allowUnconfined: true, appArgs: [app, "hidden"] },
)
process.stdout.write(`${target.sandbox}\n`)
setInterval(() => undefined, 60_000)
