// GET /api/config — reports which integrations the server has keys for. Booleans only, never values.
const { json, env } = require('./_shared');

module.exports = (req, res) => {
  json(res, 200, {
    enabled: {
      deepgram: !!env('DEEPGRAM_API_KEY'),
      requesty: !!env('REQUESTY_API_KEY'),
      slack: !!env('Bot_User_OAuth_Token'),
      getoverview: !!(env('GetOverview_BASE_URL') && env('GetOverview_Access_Token')),
    },
  });
};
