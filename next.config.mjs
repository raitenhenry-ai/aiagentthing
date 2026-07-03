/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite (dev/test database) ships WASM assets that must not be bundled.
  experimental: {
    serverComponentsExternalPackages: ['@electric-sql/pglite'],
  },
};

export default nextConfig;
