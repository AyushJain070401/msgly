/** @type {import('next').NextConfig} */

// GitHub Pages serves a project site from /<repo>. Set BASE_PATH in CI.
const basePath = process.env.BASE_PATH ?? '';

const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
