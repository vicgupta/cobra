import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Job 17: Team and Repos moved under Settings. 307 (permanent: false); the query string is passed through.
  async redirects() {
    return [
      { source: "/team", destination: "/settings/team", permanent: false },
      // Job 31: /repos is now the Repos section (Overview, Issues, Pull Requests, Branches, Activity);
      // the repo list and tokens stay at /settings/repos. Old Issues and PR URLs move under /repos.
      { source: "/repos", destination: "/repos/overview", permanent: false },
      { source: "/issues/:path*", destination: "/repos/issues/:path*", permanent: false },
      { source: "/pulls/:path*", destination: "/repos/pull-requests/:path*", permanent: false },
      // Job 24: Test run moved under Settings (run detail pages /runs/<id> stay put).
      { source: "/runs/new", destination: "/settings/test-run", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
