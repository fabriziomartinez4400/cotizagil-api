require('dotenv').config();

function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid API key' });
  }
  next();
}

module.exports = apiKeyAuth;
