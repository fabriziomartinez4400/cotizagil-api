require('dotenv').config();
const express    = require('express');
const apiKeyAuth = require('./middleware/auth');
const productos  = require('./routes/productos');
const cotizaciones = require('./routes/cotizaciones');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check — no auth required
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// All other routes require the API key
app.use(apiKeyAuth);
app.use('/productos',    productos);
app.use('/cotizaciones', cotizaciones);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`CotizAgil API running on port ${PORT}`);
});
