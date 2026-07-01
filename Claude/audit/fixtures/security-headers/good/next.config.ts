import type { NextConfig } from "next";

// GOOD fixture: configures all five required security response headers.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "default-src 'self'; script-src 'self'; object-src 'none'",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
