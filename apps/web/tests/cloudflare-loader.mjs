export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = globalThis[Symbol.for('mmi.test.cloudflare.env')] ?? {};",
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
