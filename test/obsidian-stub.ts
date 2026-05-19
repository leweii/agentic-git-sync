// Minimal `obsidian` stand-in for the vitest environment. The real
// module is provided by Obsidian at runtime and has no npm package.
// Only the surface the test path touches needs to exist here.

export const Platform = {
  isDesktop: true,
  isMobile: false,
};

export function requestUrl(): never {
  throw new Error("requestUrl is not available in the test environment.");
}
