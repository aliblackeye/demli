/**
 * Id generation for the per-app glue (message nonces, etc.). Injectable so
 * platforms without `crypto.randomUUID` can supply their own generator.
 *
 * The default uses `globalThis.crypto?.randomUUID` — present in the browser and
 * the Electron renderer. React Native lacks it until a polyfill is installed,
 * so mobile either installs `react-native-get-random-values` (making the
 * default work) or passes its own {@link IdGenerator}.
 */
export type IdGenerator = () => string;

/** Non-crypto fallback for environments without `crypto.randomUUID`. */
function fallbackId(): string {
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const defaultIdGenerator: IdGenerator = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? fallbackId();
};
