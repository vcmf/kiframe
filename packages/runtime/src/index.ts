/** Playwright automation: target resolution and the scenario runner (docs/OBJECT-MODEL.md §2–2b). */
export * from "./errors.ts"
export * from "./targets.ts"
export * from "./lasting.ts"
export * from "./motion.ts"
export * from "./network.ts"
export * from "./recorder.ts"
export * from "./runner.ts"
export * from "./scanner.ts"
export { type CastFrame, watchScreencast } from "./screencast.ts"
export {
  allowedPage,
  type ElectronLaunch,
  ElectronLaunchError,
  type ElectronTarget,
  launchElectron,
} from "./electron.ts"
export { defaultWorkDir, sweepWorkArea, WorkAreaError } from "./electron-workarea.ts"
export {
  codeDigest,
  type DesktopApp,
  inspectDesktopApp,
  InspectError,
  type Signer,
  signatureHolds,
  signerOf,
} from "./electron-inspect.ts"
export { trialDesktopApp, type TrialOptions, type TrialOutcome } from "./electron-trial.ts"
export { ConfinementError, FILES_LIMITS, seatbeltProfile } from "./electron-confine.ts"
export { LookRefusal, maskedScreenshot, type MaskedShot } from "./look.ts"
export {
  fitImage,
  type FittedImage,
  imageHeader,
  type ImageHeader,
  ImageRefusal,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
} from "./image.ts"
export { formValues, type FormValue, longEnoughToKnow, typedValues } from "./form-values.ts"
export { normalizeText } from "./text-match.ts"
export { viewOf, type PageView } from "./scroller.ts"
export { addKnownValues, isSafeSelector, knownValuesOf } from "./secret-state.ts"
export * from "./batch.ts"
