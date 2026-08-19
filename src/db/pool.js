const sql = require('mssql');
require('dotenv').config();

const config = {
  server:   process.env.DB_SERVER   || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 1433,
  database: process.env.DB_DATABASE || 'BDCOTIZAGIL',
  options: {
    encrypt:                process.env.DB_ENCRYPT                    !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE   !== 'false',
  },
};

if (process.env.DB_TRUSTED_CONNECTION === 'true') {
  config.options.trustedConnection = true;
} else {
  config.user     = process.env.DB_USER;
  config.password = process.env.DB_PASSWORD;
}

let pool = null;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
  }
  return pool;
}

module.exports = { getPool, sql };
