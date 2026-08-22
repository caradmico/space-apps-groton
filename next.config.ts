import type { NextConfig } from "next";

// GitHub project Pages lives at /space-apps-groton. actions/configure-pages
// sets PAGES_BASE_PATH; local `next dev` / `next build` stay at `/`.
const basePath = process.env.PAGES_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
