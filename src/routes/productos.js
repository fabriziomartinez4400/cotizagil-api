const express = require('express');
const { getPool, sql } = require('../db/pool');

const router = express.Router();

const TERM_ALIASES = {
  RACHET: 'RATCHET',
};

// Strip trailing 's' from Spanish plurals: "llaves"→"llave%", "alicates"→"alicate%"
function stem(word) {
  return (word.length >= 4 && /s$/i.test(word)) ? word.slice(0, -1) : word;
}

// Apply stem() only to pure-text tokens that contain no digit.
// Measurements (7-5/8") and technical tokens (BK7000, T6, 12P) match verbatim.
function shouldStem(word) {
  return !/\d/.test(word);
}

function normalizeQuery(q) {
  return q.toUpperCase().split(/\s+/).map(w => TERM_ALIASES[w] || w).join(' ');
}

// A token is a MEASUREMENT if it encodes a physical dimension:
//   contains "/" (fraction: 3/8, 7-5/8, 1/2X10")
//   ends with " (inches: 2", 12")
//   ends with MM or CM (metric: 19MM, 300MM)
// Known limitation: textually distinct representations of the same dimension
// ("300MM" vs "300 MM") are treated as different strings and do not cross-match.
const MEASURE_PAT = /\/|"$|(MM|CM)$/i;

// Split normalized query into tokens, preserving short-but-meaningful tokens:
//   - measurements and tokens with digits kept regardless of length (2", T6, M8)
//   - pure-text tokens kept only if length >= 3 (drops DE, LA, X, Y standalone)
function tokenizeQuery(q) {
  return normalizeQuery(q)
    .split(/\s+/)
    .filter(w => MEASURE_PAT.test(w) || /\d/.test(w) || w.length >= 3);
}

// Two token types:
//   'measurement' — physical dimension (required to match, weight 2 in rank)
//   'strong'      — everything else: descriptors and numeric specs (threshold, weight 1)
function classifyToken(word) {
  if (MEASURE_PAT.test(word)) return 'measurement';
  return 'strong';
}

function buildWordClauses(words, request) {
  return words.map((word, i) => {
    const patternStr = shouldStem(word) ? stem(word) : word;
    request.input(`w${i}`, sql.VarChar, `%${patternStr}%`);
    return `p.DescripcionProducto LIKE @w${i}`;
  });
}

// Minimum strong-token matches for OR fallback.
// When no strong tokens exist (all-measurement query), uses all tokens as pool.
// Capped at available pool size so the threshold is always achievable.
function computeMinMatch(words) {
  const strong = words.filter(w => classifyToken(w) !== 'measurement');
  const pool   = strong.length > 0 ? strong : words;
  return Math.min(Math.max(2, Math.ceil(pool.length / 2)), pool.length);
}

// Pure-JS simulation of the OR fallback qualification logic — mirrors the SQL.
// Uses shouldStem + String.includes() to replicate LIKE '%pattern%'.
function scoreProduct(queryWords, productDesc) {
  const desc = productDesc.toUpperCase();
  let strongMatches = 0, measureMatches = 0, rankScore = 0;

  for (const word of queryWords) {
    const patternStr = shouldStem(word) ? stem(word) : word;
    if (!desc.includes(patternStr.toUpperCase())) continue;
    if (classifyToken(word) === 'measurement') {
      measureMatches++;
      rankScore += 2;
    } else {
      strongMatches++;
      rankScore += 1;
    }
  }

  const minMatch     = computeMinMatch(queryWords);
  const measureCount = queryWords.filter(w => classifyToken(w) === 'measurement').length;

  // Mirror runFallbackOR's activeClauses logic: when there are no strong tokens,
  // the threshold counts measurement matches instead.
  const hasStrong        = queryWords.some(w => classifyToken(w) !== 'measurement');
  const thresholdMatches = hasStrong ? strongMatches : measureMatches;

  return {
    qualifies: thresholdMatches >= minMatch &&
               (measureCount === 0 || measureMatches >= measureCount),
    rankScore,
    strongMatches,
    measureMatches,
  };
}

/**
 * GET /productos/buscar?q=TERM&limit=20&moneda=USD
 *
 * Multi-word AND search with scored OR fallback:
 *   1. Normalize: uppercase + apply TERM_ALIASES (e.g. RACHET→RATCHET).
 *   2. Tokenize: measurements and digit-tokens kept regardless of length;
 *      pure-text tokens kept if length >= 3 (drops DE, LA, X standalone).
 *   3. Try AND (all words must appear in description) — tightest results.
 *   4. If AND returns 0 and words.length > 1, scored OR fallback:
 *      - strong tokens must reach computeMinMatch() threshold;
 *      - ALL measurement tokens in the query must also match;
 *      - results ranked: measurement=2pts, strong=1pt.
 * Exact CodigoERP / SKU matches always rank first.
 */
router.get('/buscar', async (req, res) => {
  const { q, limit = 20, moneda = null } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query param "q" must be at least 2 characters' });
  }

  const qTrim   = q.trim();
  const words   = tokenizeQuery(qTrim);
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
          p.IdMarca,
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

    async function runFallbackOR() {
      const tokenTypes   = words.map(classifyToken);
      const minMatch     = computeMinMatch(words);
      const measureCount = tokenTypes.filter(t => t === 'measurement').length;

      const request = pool.request()
        .input('qExact',   sql.VarChar, qTrim)
        .input('limit',    sql.Int,     maxRows)
        .input('minMatch', sql.Int,     minMatch);

      if (moneda) {
        request.input('moneda', sql.Char(3), moneda.toUpperCase());
        monedaFilter = 'AND lp.Moneda = @moneda';
      }

      if (measureCount > 0) {
        request.input('minMeasure', sql.Int, measureCount);
      }

      const allClauses     = buildWordClauses(words, request);
      const strongClauses  = allClauses.filter((_, i) => tokenTypes[i] !== 'measurement');
      const measureClauses = allClauses.filter((_, i) => tokenTypes[i] === 'measurement');
      const activeClauses  = strongClauses.length > 0 ? strongClauses : allClauses;

      const thresholdExpr = activeClauses
        .map(c => `CASE WHEN ${c} THEN 1 ELSE 0 END`)
        .join('\n          + ');

      const rankExpr = allClauses
        .map((c, i) => {
          const w = tokenTypes[i] === 'measurement' ? 2 : 1;
          return `CASE WHEN ${c} THEN ${w} ELSE 0 END`;
        })
        .join('\n          + ');

      const measureCondition = measureCount > 0
        ? `AND (${measureClauses.map(c => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(' + ')}) >= @minMeasure`
        : '';

      return request.query(`
        SELECT TOP (@limit)
          p.IdProducto, p.IdMarca, p.CodigoERP, p.SKU, p.DescripcionProducto,
          p.Umedida             AS UnidadMedida,
          p.MarcaProducto, p.CategoriaProducto, p.TipoProducto, p.Estado,
          lp.IdLPrecio, lp.Moneda, lp.Costo_Origen, lp.Precio_Lista,
          lp.Precio_P1_Contado, lp.Precio_P2_Credito, lp.Ultima_Actualizacion
        FROM PRODUCTOS p
        LEFT JOIN LISTA_PRECIOS lp ON lp.IdProducto = p.IdProducto ${monedaFilter}
        WHERE p.Estado = 'A'
          AND (
            p.CodigoERP = @qExact
            OR p.SKU    = @qExact
            OR (
              (${thresholdExpr}) >= @minMatch
              ${measureCondition}
            )
          )
        ORDER BY
          CASE WHEN p.CodigoERP = @qExact THEN 0 WHEN p.SKU = @qExact THEN 1 ELSE 2 END,
          (${rankExpr}) DESC,
          p.DescripcionProducto
      `);
    }

    let result = await runQuery('AND');

    const usedFallback = result.recordset.length === 0 && words.length > 1;
    if (usedFallback) {
      result = await runFallbackOR();
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
module.exports._helpers = {
  stem, shouldStem, normalizeQuery, tokenizeQuery,
  classifyToken, computeMinMatch, scoreProduct,
};
