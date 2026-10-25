import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Job 17: Team and Repos moved under Settings. 307 (permanent: false); the query string is passed through.
  async redirects() {
    return [
      { source: "/team", destination: "/settings/team", permanent: false },
      { source: "/repos", destination: "/settings/repos", permanent: false },
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
