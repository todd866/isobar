import type { NextConfig } from 'next';

const chartTrace = ['./public/data/**/*', './public/places/world-places.json', './public/isobar-release.json'];

const nextConfig: NextConfig = {
  // The chat route reads the published chart and its prompt from disk; serverless
  // bundles include only traced files, so name them. The connector reads the same chart.
  outputFileTracingIncludes: {
    '/api/chat': [...chartTrace, './src/lib/chat/ISOBAR.md'],
    '/api/mcp': chartTrace,
    '/api/v1/run': chartTrace,
    '/api/v1/weather/point': chartTrace,
    '/api/v1/weather/place': chartTrace,
    '/api/v1/weather/aerodrome/[icao]': chartTrace,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.ts': ['.ts', '.tsx'],
    };
    return config;
  },
};

export default nextConfig;
