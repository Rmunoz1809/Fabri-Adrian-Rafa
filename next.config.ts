import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Photos are compressed client-side to ~300 KB each; 4 photos fit comfortably.
    serverActions: { bodySizeLimit: "4mb" },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.pokemontcg.io", pathname: "/**" },
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
};

export default nextConfig;
