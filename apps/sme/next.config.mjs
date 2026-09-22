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

  // Arabic is the default, so the bare root goes there. Not permanent: the
  // landing locale should follow the authenticated principal's preference, and
  // a 308 would be cached by browsers long after that changes.
  async redirects() {
    return [{ source: '/', destination: '/ar', permanent: false }];
  },
};

export default config;
