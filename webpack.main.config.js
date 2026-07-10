const webpack = require('webpack');

module.exports = {
  entry: './src/main.js',
  module: { rules: [] },
  plugins: [
    // VERCEL_BACKEND_URL is baked in at build time (GitHub Actions secret); undefined locally.
    new webpack.DefinePlugin({
      BUILD_VERCEL_BACKEND_URL: JSON.stringify(process.env.VERCEL_BACKEND_URL || ''),
    }),
  ],
  resolve: { extensions: ['.js', '.json'] },
};
