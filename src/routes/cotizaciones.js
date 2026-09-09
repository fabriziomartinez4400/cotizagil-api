const express = require('express');
const { getPool, sql } = require('../db/pool');

const router = express.Router();

/**
 * POST /cotizaciones/cabecera
 *
 * Inserts a record into TB_COTIZA_INTERMEDIA_CAB.
 * Returns the generated Nro_CTIntermedia (IDENTITY PK).
 *
 * Schema (from INFORMATION_SCHEMA):
 *   Nro_CTIntermedia  int IDENTITY PK
 *   NroCT_Emitido     int NULL
 *   FechaEmision      datetime NULL
 *   RucCliente        char(11)  NOT NULL
 *   RazonSocial       varchar(120) NOT NULL
 *   DireccionFiscal   varchar(150) NOT NULL
 *   SolPed            varchar(50)  NOT NULL   -- purchase order / request number
 *   FormaPago         varchar(50)  NULL
 *   Moneda            char(10)     NOT NULL
 *   LugarEntrega      varchar(120) NULL
 *   Estado            varchar(15)  NOT NULL   default 'TRANSFORMADA'
 */
router.post('/cabecera', async (req, res) => {
  const {
    RucCliente,
    RazonSocial,
    DireccionFiscal,
    SolPed,
    FormaPago    = null,
    Moneda       = 'PEN',
    LugarEntrega = null,
    FechaEmision = null,
    Estado       = 'PENDIENTE',
  } = req.body;

  if (!RucCliente)      return res.status(400).json({ error: '"RucCliente" is required' });
  if (!RazonSocial)     return res.status(400).json({ error: '"RazonSocial" is required' });
  if (!DireccionFiscal) return res.status(400).json({ error: '"DireccionFiscal" is required' });
  if (!SolPed)          return res.status(400).json({ error: '"SolPed" (purchase order / request number) is required' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('RucCliente',      sql.Char(11),      RucCliente)
      .input('RazonSocial',     sql.VarChar(120),  RazonSocial)
      .input('DireccionFiscal', sql.VarChar(150),  DireccionFiscal)
      .input('SolPed',          sql.VarChar(50),   SolPed)
      .input('FormaPago',       sql.VarChar(50),   FormaPago)
      .input('Moneda',          sql.Char(10),      Moneda)
      .input('LugarEntrega',    sql.VarChar(120),  LugarEntrega)
      .input('FechaEmision',    sql.DateTime,      FechaEmision ? new Date(FechaEmision) : new Date())
      .input('Estado',          sql.VarChar(15),   Estado)
      .query(`
        INSERT INTO TB_COTIZA_INTERMEDIA_CAB
          (FechaEmision, RucCliente, RazonSocial, DireccionFiscal,
           SolPed, FormaPago, Moneda, LugarEntrega, Estado)
        OUTPUT INSERTED.Nro_CTIntermedia
        VALUES
          (@FechaEmision, @RucCliente, @RazonSocial, @DireccionFiscal,
           @SolPed, @FormaPago, @Moneda, @LugarEntrega, @Estado)
      `);

    const nroCT = result.recordset[0].Nro_CTIntermedia;
    res.status(201).json({ Nro_CTIntermedia: nroCT });
  } catch (err) {
    console.error('[cotizaciones/cabecera]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /cotizaciones/:id/detalle
 *
 * Appends one line item to TB_COTIZA_INTERMEDIA_DET.
 * Auto-increments Item number. Accepts IdProducto or SKU to resolve
 * the product — at minimum DescripcionProducto + UnidadMedida + MarcaProducto
 * must be supplied if the product cannot be resolved from IdProducto.
 *
 * Schema (from INFORMATION_SCHEMA):
 *   Nro_CTIntermedia  int  NOT NULL  FK → CAB
 *   Item              int  NOT NULL
 *   IdProducto        int  NULL
 *   SKU               varchar(40)  NULL
 *   DescripcionProducto varchar(200) NOT NULL
 *   UnidadMedida      varchar(5)   NOT NULL
 *   Cantidad          decimal(10,2) NOT NULL
 *   IdMarca           int  NULL
 *   MarcaProducto     varchar(30)  NOT NULL
 */
router.post('/:id/detalle', async (req, res) => {
  const nroCT = parseInt(req.params.id);
  if (isNaN(nroCT)) return res.status(400).json({ error: 'Invalid quotation id' });

  const {
    IdProducto          = null,
    SKU                 = null,
    DescripcionProducto,
    UnidadMedida,
    Cantidad,
    IdMarca             = null,
    MarcaProducto,
  } = req.body;

  if (!DescripcionProducto) return res.status(400).json({ error: '"DescripcionProducto" is required' });
  if (!UnidadMedida)        return res.status(400).json({ error: '"UnidadMedida" is required' });
  if (Cantidad == null)     return res.status(400).json({ error: '"Cantidad" is required' });
  if (!MarcaProducto)       return res.status(400).json({ error: '"MarcaProducto" is required' });

  try {
    const pool = await getPool();

    // Verify header exists
    const check = await pool.request()
      .input('nroCT', sql.Int, nroCT)
      .query('SELECT Nro_CTIntermedia FROM TB_COTIZA_INTERMEDIA_CAB WHERE Nro_CTIntermedia = @nroCT');

    if (check.recordset.length === 0) {
      return res.status(404).json({ error: `Quotation ${nroCT} not found` });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      const result = await new sql.Request(transaction)
        .input('nroCT',               sql.Int,          nroCT)
        .input('IdProducto',          sql.Int,          IdProducto)
        .input('SKU',                 sql.VarChar(40),  SKU)
        .input('DescripcionProducto', sql.VarChar(200), DescripcionProducto)
        .input('UnidadMedida',        sql.VarChar(5),   UnidadMedida)
        .input('Cantidad',            sql.Decimal(10,2),parseFloat(Cantidad))
        .input('IdMarca',             sql.Int,          IdMarca)
        .input('MarcaProducto',       sql.VarChar(30),  MarcaProducto)
        .query(`
          DECLARE @lockResource VARCHAR(40) = CONCAT('DET_', CAST(@nroCT AS VARCHAR(20)));
          DECLARE @lockResult INT;
          EXEC @lockResult = sp_getapplock
              @Resource    = @lockResource,
              @LockMode    = 'Exclusive',
              @LockOwner   = 'Transaction',
              @LockTimeout = 10000;
          IF @lockResult < 0
          BEGIN
              ROLLBACK TRANSACTION;
              THROW 50000, 'No se pudo obtener el lock para insertar el detalle', 1;
          END

          DECLARE @nextItem INT;
          SELECT @nextItem = ISNULL(MAX(Item), 0) + 1
          FROM TB_COTIZA_INTERMEDIA_DET
          WHERE Nro_CTIntermedia = @nroCT;

          INSERT INTO TB_COTIZA_INTERMEDIA_DET
            (Nro_CTIntermedia, Item, IdProducto, SKU,
             DescripcionProducto, UnidadMedida, Cantidad, IdMarca, MarcaProducto)
          OUTPUT INSERTED.Item
          VALUES
            (@nroCT, @nextItem, @IdProducto, @SKU,
             @DescripcionProducto, @UnidadMedida, @Cantidad, @IdMarca, @MarcaProducto)
        `);

      await transaction.commit();
      const item = result.recordset[0].Item;
      res.status(201).json({ Nro_CTIntermedia: nroCT, Item: item });
    } catch (err) {
      try { await transaction.rollback(); } catch (_) { /* already rolled back by T-SQL */ }
      throw err;
    }
  } catch (err) {
    console.error('[cotizaciones/detalle]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /cotizaciones/:id/resultado
 *
 * Returns the full quotation: header + line items enriched with
 * pricing from LISTA_PRECIOS, plus computed totals.
 * Query param: ?moneda=PEN|USD (default: matches the header's Moneda)
 */
router.get('/:id/resultado', async (req, res) => {
  const nroCT = parseInt(req.params.id);
  if (isNaN(nroCT)) return res.status(400).json({ error: 'Invalid quotation id' });

  try {
    const pool = await getPool();

    const cabResult = await pool.request()
      .input('nroCT', sql.Int, nroCT)
      .query('SELECT * FROM TB_COTIZA_INTERMEDIA_CAB WHERE Nro_CTIntermedia = @nroCT');

    if (cabResult.recordset.length === 0) {
      return res.status(404).json({ error: `Quotation ${nroCT} not found` });
    }

    const cabecera = cabResult.recordset[0];
    const moneda   = (req.query.moneda || cabecera.Moneda || 'PEN').trim().toUpperCase();

    const detResult = await pool.request()
      .input('nroCT',  sql.Int,     nroCT)
      .input('moneda', sql.Char(3), moneda)
      .query(`
        SELECT
          d.Item,
          d.IdProducto,
          d.SKU,
          d.DescripcionProducto,
          d.UnidadMedida,
          d.Cantidad,
          d.MarcaProducto,
          lp.Moneda,
          lp.Precio_Lista,
          lp.Precio_P1_Contado,
          lp.Precio_P2_Credito,
          lp.Costo_Origen,
          lp.Ultima_Actualizacion,
          -- Computed sub-totals using the cash price (P1)
          ROUND(d.Cantidad * ISNULL(lp.Precio_P1_Contado, 0), 2) AS SubTotal_Contado,
          ROUND(d.Cantidad * ISNULL(lp.Precio_P2_Credito, 0), 2) AS SubTotal_Credito
        FROM TB_COTIZA_INTERMEDIA_DET d
        LEFT JOIN LISTA_PRECIOS lp
          ON  lp.IdProducto = d.IdProducto
          AND lp.Moneda     = @moneda
        WHERE d.Nro_CTIntermedia = @nroCT
        ORDER BY d.Item
      `);

    const detalle = detResult.recordset;

    const subtotalContado = detalle.reduce((s, r) => s + (parseFloat(r.SubTotal_Contado) || 0), 0);
    const subtotalCredito = detalle.reduce((s, r) => s + (parseFloat(r.SubTotal_Credito) || 0), 0);
    const igvRate         = 0.18;

    res.json({
      cabecera,
      detalle,
      totales: {
        Moneda:                   moneda,
        SubTotal_Contado:         round2(subtotalContado),
        IGV_Contado:              round2(subtotalContado * igvRate),
        Total_Contado:            round2(subtotalContado * (1 + igvRate)),
        SubTotal_Credito:         round2(subtotalCredito),
        IGV_Credito:              round2(subtotalCredito * igvRate),
        Total_Credito:            round2(subtotalCredito * (1 + igvRate)),
        IGV_Rate:                 igvRate,
      },
    });
  } catch (err) {
    console.error('[cotizaciones/resultado]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /cotizaciones/:id/estado
 *
 * Updates the Estado field on the header.
 * Typical values: 'PENDIENTE', 'TRANSFORMADA', 'ANULADA'
 */
router.patch('/:id/estado', async (req, res) => {
  const nroCT = parseInt(req.params.id);
  const { Estado, NroCT_Emitido = null } = req.body;

  if (isNaN(nroCT)) return res.status(400).json({ error: 'Invalid quotation id' });
  if (!Estado)      return res.status(400).json({ error: '"Estado" is required' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('nroCT',        sql.Int,        nroCT)
      .input('Estado',       sql.VarChar(15),Estado)
      .input('NroCT_Emitido',sql.Int,        NroCT_Emitido)
      .query(`
        UPDATE TB_COTIZA_INTERMEDIA_CAB
        SET Estado       = @Estado,
            NroCT_Emitido = ISNULL(@NroCT_Emitido, NroCT_Emitido)
        OUTPUT INSERTED.Nro_CTIntermedia, INSERTED.Estado, INSERTED.NroCT_Emitido
        WHERE Nro_CTIntermedia = @nroCT
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: `Quotation ${nroCT} not found` });
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('[cotizaciones/estado]', err);
    res.status(500).json({ error: err.message });
  }
});

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = router;
