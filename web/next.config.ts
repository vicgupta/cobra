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
      // Job 4 (Oct 2026): Test run retired. Old links go to the dashboard; /runs/<id> detail pages stay.
      { source: "/runs/new", destination: "/", permanent: false },
      { source: "/settings/test-run", destination: "/", permanent: false },
      // Job 7 (Oct 2026): Sessions moved from the header menu into Settings.
      { source: "/account/sessions", destination: "/settings/sessions", permanent: false },
      { source: "/sessions", destination: "/settings/sessions", permanent: false },
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
