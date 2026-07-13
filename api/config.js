// GET /api/config — reports which integrations the server has keys for. Booleans only, never values.
const { json, env } = require('./_shared');

module.exports = (req, res) => {
  json(res, 200, {
    enabled: {
      deepgram: !!env('DEEPGRAM_API_KEY'),
      requesty: !!env('REQUESTY_API_KEY'),
      slack: !!(env('SLACK_CLIENT_ID') && env('SLACK_CLIENT_SECRET')), // OAuth available → show Connect button
      getoverview: !!(env('GetOverview_BASE_URL') && env('GetOverview_Access_Token')),
    },
  });
};
