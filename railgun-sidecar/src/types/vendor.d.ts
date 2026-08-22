/**
 * Ambient declarations for two runtime dependencies that ship no types.
 *
 * Both are used through a narrow surface (one constructor, one property), so a
 * minimal declaration is more honest than pulling in a stale @types package —
 * and it keeps `strict` on for our own code rather than disabling noImplicitAny
 * globally to accommodate two imports.
 */

declare module "leveldown" {
  /** AbstractLevelDOWN store backing the Railgun engine database. */
  const LevelDOWN: new (location: string) => unknown;
  export = LevelDOWN;
}

declare module "snarkjs" {
  /** Groth16 prover handed to the Railgun engine via getProver().setSnarkJSGroth16. */
  export const groth16: unknown;
}
