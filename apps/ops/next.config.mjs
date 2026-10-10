/**
 * The operations workbench.
 *
 * A separate deployable from the SME portal, deliberately. That surface is
 * internet-facing to counterparties; this one is internal and carries maker
 * and checker authority. Sharing a deployable would mean sharing a trust
 * boundary, and no amount of route guarding makes that the same thing
 * (SDD §4.7, §7.2).
 */
const config = {
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // A self-contained server for the container image (apps/ops/Containerfile).
  output: 'standalone',
  reactStrictMode: true,
  // No X-Powered-By: the framework is nobody's business (ZAP 10037).
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [{ source: '/', destination: '/en', permanent: false }];
  },
};

export default config;
