import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  // holo-pay lives inside the main repo: don't let Next pick the parent lockfile as the root.
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
