/**
 * The consumer surface: an applicant's own journey on their own phone.
 *
 * A separate deployable from the workbench and the SME portal: this one is
 * internet-facing to individuals and carries their identity assertion, and
 * sharing a deployable would mean sharing a trust boundary. It imports the
 * product engine directly, so the disclosure the applicant accepts is the
 * same `Offer` the platform computed — there is no copy in between.
 */
const config = {
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // A self-contained server for the container image (apps/consumer/Containerfile).
  output: 'standalone',
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [{ source: '/', destination: '/ar', permanent: false }];
  },
};

export default config;
