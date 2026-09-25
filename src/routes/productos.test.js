// Run: node --test src/routes/productos.test.js
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Importing the route does NOT connect to DB — getPool() is lazy.
const { stem, shouldStem, normalizeQuery, tokenizeQuery,
        classifyToken, computeMinMatch, scoreProduct } =
  require('./productos')._helpers;

// ── stem ──────────────────────────────────────────────────────────────────────

test('stem: strips trailing s from words >= 4 chars', () => {
  assert.equal(stem('LLAVES'),   'LLAVE');
  assert.equal(stem('ALICATES'), 'ALICATE');
  assert.equal(stem('RATCHETS'), 'RATCHET');
});

test('stem: leaves short, non-plural, and special tokens unchanged', () => {
  assert.equal(stem('LAS'),     'LAS');
  assert.equal(stem('CORTE'),   'CORTE');
  assert.equal(stem('RATCHET'), 'RATCHET');
  assert.equal(stem('19MM'),    '19MM');
});

// ── shouldStem ────────────────────────────────────────────────────────────────

test('shouldStem: true for pure-text tokens (no digit)', () => {
  assert.equal(shouldStem('ALICATE'),    true);
  assert.equal(shouldStem('DIAGONAL'),   true);
  assert.equal(shouldStem('BIMATERIAL'), true);
  assert.equal(shouldStem('LLAVES'),     true);
});

test('shouldStem: false for any token with a digit', () => {
  assert.equal(shouldStem('19MM'),    false);
  assert.equal(shouldStem('12"'),     false);
  assert.equal(shouldStem('7-5/8"'),  false);
  assert.equal(shouldStem('BK7000'),  false);
  assert.equal(shouldStem('T6'),      false);
  assert.equal(shouldStem('M8'),      false);
  assert.equal(shouldStem('12P'),     false);
  assert.equal(shouldStem('10TPI'),   false);
  assert.equal(shouldStem('18V'),     false);
  assert.equal(shouldStem('1000V'),   false);
});

// ── normalizeQuery ────────────────────────────────────────────────────────────

test('normalizeQuery: uppercases and corrects RACHET → RATCHET', () => {
  assert.equal(normalizeQuery('rachet 1/2'), 'RATCHET 1/2');
  assert.equal(normalizeQuery('RACHET CABEZA PERA'), 'RATCHET CABEZA PERA');
});

// ── tokenizeQuery ─────────────────────────────────────────────────────────────

test('tokenizeQuery: ESPATULA FLEXIBLE 2" keeps 2" (length 2, measurement)', () => {
  assert.deepEqual(tokenizeQuery('ESPATULA FLEXIBLE 2"'), ['ESPATULA', 'FLEXIBLE', '2"']);
});

test('tokenizeQuery: LLAVE 8" keeps 8"', () => {
  assert.deepEqual(tokenizeQuery('LLAVE 8"'), ['LLAVE', '8"']);
});

test('tokenizeQuery: TORX T6 keeps T6 (has digit, length 2)', () => {
  assert.deepEqual(tokenizeQuery('TORX T6'), ['TORX', 'T6']);
});

test('tokenizeQuery: M8 alone is kept (has digit)', () => {
  assert.deepEqual(tokenizeQuery('M8'), ['M8']);
});

test('tokenizeQuery: DADO CROMADO TUBULAR 3/8" X 19MM 12P drops standalone X', () => {
  assert.deepEqual(
    tokenizeQuery('DADO CROMADO TUBULAR 3/8" X 19MM 12P'),
    ['DADO', 'CROMADO', 'TUBULAR', '3/8"', '19MM', '12P']
  );
});

test('tokenizeQuery: drops DE, Y as short pure-text connectors', () => {
  const tokens = tokenizeQuery('LLAVE DE IMPACTO Y CORTE');
  assert.ok(!tokens.includes('DE'), 'DE should be dropped');
  assert.ok(!tokens.includes('Y'),  'Y should be dropped');
  assert.ok(tokens.includes('LLAVE') && tokens.includes('IMPACTO') && tokens.includes('CORTE'));
});

test('tokenizeQuery: applies RACHET alias before tokenizing', () => {
  const tokens = tokenizeQuery('RACHET CABEZA PERA');
  assert.ok(tokens.includes('RATCHET'));
  assert.ok(!tokens.includes('RACHET'));
});

// ── classifyToken ─────────────────────────────────────────────────────────────

test('classifyToken: pure text and numeric specs → strong', () => {
  for (const w of ['ALICATE','CORTE','DIAGONAL','BIMATERIAL',
                   'T6','M8','12P','10TPI','18V','48T','1000V','8PTS',
                   'BK7000','ST09709SJ','40134','3050-159']) {
    assert.equal(classifyToken(w), 'strong', `expected strong for "${w}"`);
  }
});

test('classifyToken: fractions, inch, metric → measurement', () => {
  for (const w of ['1/2','3/8','7-5/8"','1/2X10"','12"','2"','8"','10"',
                   '19MM','300MM','30CM','1/4X4"','7-1/2"','3/8"']) {
    assert.equal(classifyToken(w), 'measurement', `expected measurement for "${w}"`);
  }
});

// ── computeMinMatch ───────────────────────────────────────────────────────────

test('computeMinMatch: measurements excluded from threshold count', () => {
  assert.equal(computeMinMatch(['ALICATE', 'CORTE', 'DIAGONAL', '7-5/8"']),             2);
  assert.equal(computeMinMatch(['RATCHET', 'CABEZA', 'PERA', 'REVERSIBLE', '1/2X10"']), 2);
  assert.equal(computeMinMatch(['DESARMADOR', 'PLANO', 'BIMATERIAL', '1/4X4"']),        2);
  assert.equal(computeMinMatch(['CUTTER', 'CAMBIO', 'RAPIDO', '7-1/2"']),               2);
});

test('computeMinMatch: 1 strong + 1 measure → capped at 1', () => {
  assert.equal(computeMinMatch(['LLAVE', '12"']), 1);
  assert.equal(computeMinMatch(['RATCHET', '1/2']), 1);
});

test('computeMinMatch: 12P is strong, counted toward threshold', () => {
  assert.equal(computeMinMatch(['DADO', 'CROMADO', 'TUBULAR', '3/8"', '19MM', '12P']), 2);
});

test('computeMinMatch: 5 strong tokens → minMatch=3', () => {
  assert.equal(computeMinMatch(['RATCHET', 'CABEZA', 'PERA', 'REVERSIBLE', 'HEXAGONAL']), 3);
});

test('computeMinMatch: all-measurement query uses measurements as pool', () => {
  assert.equal(computeMinMatch(['3/8"', '19MM']), 2);
});

// ── scoreProduct — qualification scenarios ────────────────────────────────────

// Scenario A: ALICATE CORTE DIAGONAL 7-5/8"
test('A: CORTE alone (1 strong, no measure) → does not qualify', () => {
  const words = tokenizeQuery('ALICATE CORTE DIAGONAL 7-5/8"');
  assert.equal(
    scoreProduct(words, '4" - 10TPI - HCS - CORTE MADERA FINO').qualifies,
    false
  );
});

test('A: ACEITE DE CORTE NUCLEAR → does not qualify (1 strong match)', () => {
  const words = tokenizeQuery('ALICATE CORTE DIAGONAL 7-5/8"');
  assert.equal(
    scoreProduct(words, 'ACEITE DE CORTE NUCLEAR PARA ROSCAR X 1GL').qualifies,
    false
  );
});

test('A: genuine match qualifies', () => {
  const words = tokenizeQuery('ALICATE CORTE DIAGONAL 7-5/8"');
  const r = scoreProduct(words, 'ALICATE DE CORTE DIAGONAL 7-5/8" URREA');
  assert.equal(r.qualifies, true);
  assert.equal(r.measureMatches, 1);
});

// Scenario B: DESARMADOR PLANO BIMATERIAL 1/4X4"
test('B: BARRA PALANCA MANGO BIMATERIAL → does not qualify (1 strong match)', () => {
  const words = tokenizeQuery('DESARMADOR PLANO BIMATERIAL 1/4X4"');
  const r = scoreProduct(words, 'BARRA DE PALANCA MANGO BIMATERIAL 650MM');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 1);
});

test('B: DESARMADOR PLANO BIMATERIAL different size → measure mismatch', () => {
  const words = tokenizeQuery('DESARMADOR PLANO BIMATERIAL 1/4X4"');
  const r = scoreProduct(words, 'DESARMADOR PLANO BIMATERIAL 3/16X4"');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 3);
  assert.equal(r.measureMatches, 0);
});

// Scenario C: CUTTER CAMBIO RAPIDO 7-1/2"
test('C: CARGADOR RAPIDO → does not qualify (1 strong match)', () => {
  const words = tokenizeQuery('CUTTER CAMBIO RAPIDO 7-1/2"');
  assert.equal(scoreProduct(words, 'CARGADOR RAPIDO 12V').qualifies, false);
});

test('C: CUTTER 8PTS 18MM → does not qualify (1 strong match, no measure)', () => {
  const words = tokenizeQuery('CUTTER CAMBIO RAPIDO 7-1/2"');
  const r = scoreProduct(words, 'CUTTER 8PTS 18MM BIMATERIAL');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 1);
});

// Scenario D: RATCHET CABEZA PERA REVERSIBLE 1/2X10"
test('D: BOTA DE SEGURIDAD → does not qualify', () => {
  const words = tokenizeQuery('RATCHET CABEZA PERA REVERSIBLE 1/2X10"');
  assert.equal(scoreProduct(words, 'BOTA DE SEGURIDAD PUNTA ACERO TALLA 42').qualifies, false);
});

test('D: RATCHET SCREWDRIVER SET → does not qualify (1 strong, no measure)', () => {
  const words = tokenizeQuery('RATCHET CABEZA PERA REVERSIBLE 1/2X10"');
  const r = scoreProduct(words, 'RATCHET SCREWDRIVER SET 31PCS');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 1);
});

// Scenario E: RACHET normalization
test('E: RACHET and RATCHET produce identical token arrays', () => {
  assert.deepEqual(
    tokenizeQuery('RACHET CABEZA PERA'),
    tokenizeQuery('RATCHET CABEZA PERA')
  );
});

// Scenario I: LLAVE AJUSTABLE CROMADA 12"
test('I: matching product qualifies', () => {
  const words = tokenizeQuery('LLAVE AJUSTABLE CROMADA 12"');
  const r = scoreProduct(words, 'LLAVE AJUSTABLE CROMADA 12" URREA');
  assert.equal(r.qualifies, true);
  assert.equal(r.measureMatches, 1);
});

test('I: different size does not qualify (measure mismatch)', () => {
  const words = tokenizeQuery('LLAVE AJUSTABLE CROMADA 12"');
  const r = scoreProduct(words, 'LLAVE FRANCESA AJUSTABLE CROMADA 8"');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 3);
  assert.equal(r.measureMatches, 0);
});

// Scenario J: ESPATULA FLEXIBLE 2" — real case that was failing
test('J: ESPATULA ACERO different size → does not qualify (1 strong match)', () => {
  const words = tokenizeQuery('ESPATULA FLEXIBLE 2"');
  const r = scoreProduct(words, 'ESPATULA DE ACERO 3"');
  assert.equal(r.qualifies, false);
});

test('J: ESPATULA FLEXIBLE wrong size → threshold ok but measure fails', () => {
  const words = tokenizeQuery('ESPATULA FLEXIBLE 2"');
  const r = scoreProduct(words, 'ESPATULA FLEXIBLE 3"');
  assert.equal(r.qualifies, false);
  assert.equal(r.strongMatches, 2);
  assert.equal(r.measureMatches, 0);
});

test('J: ESPATULA FLEXIBLE 2" exact match qualifies', () => {
  const words = tokenizeQuery('ESPATULA FLEXIBLE 2"');
  const r = scoreProduct(words, 'ESPATULA FLEXIBLE 2" URREA');
  assert.equal(r.qualifies, true);
  assert.equal(r.measureMatches, 1);
});

// Multiple measurements: DADO CROMADO TUBULAR 3/8" X 19MM 12P
test('multiple measures: candidate with 17MM (only 1/2 measures) → does not qualify', () => {
  const words = tokenizeQuery('DADO CROMADO TUBULAR 3/8" X 19MM 12P');
  assert.deepEqual(words, ['DADO', 'CROMADO', 'TUBULAR', '3/8"', '19MM', '12P']);
  const r = scoreProduct(words, 'DADO CROMADO TUBULAR 3/8" X 17MM 12P');
  assert.equal(r.qualifies, false, `strongMatches=${r.strongMatches}, measureMatches=${r.measureMatches}`);
  assert.equal(r.measureMatches, 1);
});

test('multiple measures: exact match qualifies', () => {
  const words = tokenizeQuery('DADO CROMADO TUBULAR 3/8" X 19MM 12P');
  const r = scoreProduct(words, 'DADO CROMADO TUBULAR 3/8" X 19MM 12P STANLEY');
  assert.equal(r.qualifies, true);
  assert.equal(r.measureMatches, 2);
});

// All-measurement query (no strong tokens) — scoreProduct mirrors SQL activeClauses logic
test('all-measurement query: 3/8" 19MM - DADO 3/8" 19MM qualifies', () => {
  const words = tokenizeQuery('3/8" 19MM');
  const r = scoreProduct(words, 'DADO 3/8" 19MM');
  assert.equal(r.qualifies, true);
  assert.equal(r.measureMatches, 2);
});

test('all-measurement query: 3/8" 19MM - product with only one measure does not qualify', () => {
  const words = tokenizeQuery('3/8" 19MM');
  const r = scoreProduct(words, 'DADO 3/8" X 17MM');
  assert.equal(r.qualifies, false);
  assert.equal(r.measureMatches, 1);
});

// Ranking correctness
test('ranking: more matching tokens → higher score', () => {
  const words = tokenizeQuery('RATCHET CABEZA PERA REVERSIBLE 1/2X10"');
  const r1 = scoreProduct(words, 'RATCHET CABEZA PERA REVERSIBLE 1/2X10"');
  const r2 = scoreProduct(words, 'RATCHET REVERSIBLE 1/2X10"');
  assert.ok(r1.rankScore > r2.rankScore);
  assert.equal(r1.qualifies, true);
  assert.equal(r2.qualifies, true);
});

test('ranking: measurement match (2pts) > strong match (1pt)', () => {
  const words = tokenizeQuery('LLAVE 19MM');
  const r = scoreProduct(words, 'LLAVE 19MM CROMADA');
  assert.equal(r.rankScore, 3); // LLAVE=1 + 19MM=2
  assert.equal(r.qualifies, true);
});
