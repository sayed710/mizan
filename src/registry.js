// Model registry. Modules that look up model definitions at call time import `models` from here,
// so they don't import models/index.js (which imports every business module back, ARCH-004).
// models/index.js fills it once at load; any entry point that uses records must import models/index.js.
export const models = {};

/** Fills the registry with the composed model definitions and returns it (same object every time). */
export function registerModels(defs) {
  Object.assign(models, defs);
  return models;
}
