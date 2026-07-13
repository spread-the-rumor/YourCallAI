const webpack = require('webpack');

module.exports = {
  entry: './src/main.js',
  module: { rules: [] },
  plugins: [
    // VERCEL_BACKEND_URL is baked in at build time (GitHub Actions secret); undefined locally.
    // Supabase URL + anon key are likewise baked in; anon key is public by design (RLS protects data).
    new webpack.DefinePlugin({
      BUILD_VERCEL_BACKEND_URL: JSON.stringify(process.env.VERCEL_BACKEND_URL || ''),
      BUILD_SUPABASE_URL: JSON.stringify(process.env.SUPABASE_URL || ''),
      BUILD_SUPABASE_ANON_KEY: JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
      // App-token gates the proxy; Slack client id is public (rides in the authorize URL).
      BUILD_APP_PROXY_TOKEN: JSON.stringify(process.env.APP_PROXY_TOKEN || ''),
      BUILD_SLACK_CLIENT_ID: JSON.stringify(process.env.SLACK_CLIENT_ID || ''),
    }),
  ],
  resolve: { extensions: ['.js', '.json'] },
};
