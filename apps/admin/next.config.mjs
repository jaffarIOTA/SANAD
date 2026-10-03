/**
 * The administration surface: tenant configuration, credentials (write-only,
 * to the vault), rails, staff identity and partner entitlements. A separate
 * deployable from the workbench because it holds the authority to change what
 * the workbench enforces; the two must never share a trust boundary.
 */
const config = {
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [{ source: '/', destination: '/en', permanent: false }];
  },
};

export default config;
