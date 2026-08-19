const express = require('express');
const { getPool, sql } = require('../db/pool');

const router = express.Router();

// Strip trailing 's' from Spanish plurals so "lampas"→"lampa%", "llaves"→"llave%"
function stem(word) {
  return (word.length >= 4 && word.endsWith('s')) ? word.slice(0, -1) : word;
}

function buildWordClauses(words, request) {
  return words.map((word, i) => {
    const pattern = `%${stem(word)}%`;
    request.input(`w${i}`, sql.VarChar, pattern);
    return `p.DescripcionProducto LIKE @w${i}`;
  });
}

/**
 * GET /productos/buscar?q=TERM&limit=20&moneda=USD
 *
 * Multi-word AND search with automatic OR fallback:
 *   1. Split query into words ≥ 3 chars, apply basic plural stemming.
 *   2. Try AND (all words must appear) — returns tightest results.
 *   3. If AND returns 0, retry with OR (any word must appear).
 * Exact CodigoERP / SKU matches always rank first (score 0 / 1).
 */
router.get('/buscar', async (req, res) => {
  const { q, limit = 20, moneda = null } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query param "q" must be at least 2 characters' });
  }

  const qTrim  = q.trim();
  const words  = qTrim.split(/\s+/).filter(w => w.length >= 3);
  const maxRows = Math.min(parseInt(limit) || 20, 100);

  try {
    const pool = await getPool();

    let monedaFilter = '';

    async function runQuery(operator) {
      const request = pool.request()
        .input('qExact', sql.VarChar, qTrim)
        .input('limit',  sql.Int,     maxRows);

      if (moneda) {
        request.input('moneda', sql.Char(3), moneda.toUpperCase());
        monedaFilter = 'AND lp.Moneda = @moneda';
      }

      let wordConditions;
      if (words.length > 0) {
        const clauses = buildWordClauses(words, request);
        wordConditions = clauses.join(` ${operator} `);
      } else {
        request.input('qLike', sql.VarChar, `%${qTrim}%`);
        wordConditions = 'p.DescripcionProducto LIKE @qLike';
      }

      return request.query(`
        SELECT TOP (@limit)
          p.IdProducto,
          p.CodigoERP,
          p.SKU,
          p.DescripcionProducto,
          p.Umedida             AS UnidadMedida,
          p.MarcaProducto,
          p.CategoriaProducto,
          p.TipoProducto,
          p.Estado,
          lp.IdLPrecio,
          lp.Moneda,
          lp.Costo_Origen,
          lp.Precio_Lista,
          lp.Precio_P1_Contado,
          lp.Precio_P2_Credito,
          lp.Ultima_Actualizacion
        FROM PRODUCTOS p
        LEFT JOIN LISTA_PRECIOS lp ON lp.IdProducto = p.IdProducto
          ${monedaFilter}
        WHERE p.Estado = 'A'
          AND (
            p.CodigoERP = @qExact
            OR p.SKU    = @qExact
            OR (${wordConditions})
          )
        ORDER BY
          CASE
            WHEN p.CodigoERP = @qExact THEN 0
            WHEN p.SKU       = @qExact THEN 1
            ELSE 2
          END,
          p.DescripcionProducto
      `);
    }

    // Pass 1: AND (all words must match)
    let result = await runQuery('AND');

    // Pass 2: OR fallback if AND returns nothing and there were multiple words
    const usedFallback = result.recordset.length === 0 && words.length > 1;
    if (usedFallback) {
      result = await runQuery('OR');
    }

    res.json({
      total:    result.recordset.length,
      fallback: usedFallback,
      items:    result.recordset,
    });
  } catch (err) {
    console.error('[productos/buscar]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
