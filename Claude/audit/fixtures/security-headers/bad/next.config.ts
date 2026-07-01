import type { NextConfig } from "next";

// BAD fixture: a header config that sets only ONE of the five required headers.
// Only the framing guard below is set; the other four required response headers
// are absent, so this config must be flagged as a finding.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default nextConfig;
