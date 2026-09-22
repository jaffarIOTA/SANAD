/**
 * The SME surface.
 *
 * `outputFileTracingRoot` points at the repository root because this app
 * imports the domain directly from `core/` — the pricing the offer screen
 * renders is the same `MurabahaPricing` the instrument renders from, and that
 * only holds if there is no copy in between.
 */
const config = {
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default config;
