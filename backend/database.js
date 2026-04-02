// backend/database.js
import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Crear tablas si no existen
await db.executeMultiple(`
  CREATE TABLE IF NOT EXISTS pedidos (
    token TEXT PRIMARY KEY,
    numero TEXT NOT NULL,
    estado TEXT DEFAULT 'preparacion',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    creado_por TEXT,
    marcado_listo_por TEXT,
    retirado_por TEXT,
    timestamp_listo DATETIME,
    timestamp_retiro DATETIME,
    subscription_data TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
  CREATE INDEX IF NOT EXISTS idx_pedidos_timestamp ON pedidos(timestamp);

  CREATE TABLE IF NOT EXISTS contadores (
    fecha TEXT PRIMARY KEY,
    ultimo_numero INTEGER DEFAULT 0,
    reseteado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ===== UTILIDADES =====

export const getFechaHoy = () => {
  const ahora = new Date();
  const año = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${año}${mes}${dia}`;
};

export const siguienteNumeroPedido = async () => {
  const fecha = getFechaHoy();

  const result = await db.execute({
    sql: `INSERT INTO contadores (fecha, ultimo_numero) VALUES (?, 1)
          ON CONFLICT(fecha) DO UPDATE SET ultimo_numero = ultimo_numero + 1
          RETURNING ultimo_numero`,
    args: [fecha]
  });

  return result.rows[0].ultimo_numero;
};

export const generarNumeroPedido = async () => {
  const fecha = getFechaHoy();
  const consecutivo = (await siguienteNumeroPedido()).toString().padStart(3, '0');
  return `${fecha}-${consecutivo}`;
};

// ===== CRUD DE PEDIDOS =====

export const crearPedido = async ({ token, numero, creadoPor, subscriptionData = null }) => {
  await db.execute({
    sql: `INSERT INTO pedidos (token, numero, estado, creado_por, subscription_data)
          VALUES (?, ?, 'preparacion', ?, ?)`,
    args: [token, numero, creadoPor, subscriptionData ? JSON.stringify(subscriptionData) : null]
  });
};

export const obtenerPedido = async (token) => {
  const result = await db.execute({
    sql: 'SELECT * FROM pedidos WHERE token = ?',
    args: [token]
  });
  return result.rows[0] || null;
};

export const actualizarEstadoPedido = async ({ token, estado, marcadoPor, campoTimestamp }) => {
  const updates = ['estado = ?'];
  const args = [estado];

  if (marcadoPor) {
    updates.push('marcado_listo_por = ?');
    args.push(marcadoPor);
  }

  if (campoTimestamp === 'listo') {
    updates.push('timestamp_listo = CURRENT_TIMESTAMP');
  } else if (campoTimestamp === 'retiro') {
    updates.push('timestamp_retiro = CURRENT_TIMESTAMP');
  }

  args.push(token);

  await db.execute({
    sql: `UPDATE pedidos SET ${updates.join(', ')} WHERE token = ?`,
    args
  });
};

export const listarPedidos = async ({ filtro = 'todos', limite = 50 } = {}) => {
  if (filtro && filtro !== 'todos') {
    const result = await db.execute({
      sql: 'SELECT * FROM pedidos WHERE estado = ? ORDER BY timestamp DESC LIMIT ?',
      args: [filtro, limite]
    });
    return result.rows;
  }

  const result = await db.execute({
    sql: 'SELECT * FROM pedidos ORDER BY timestamp DESC LIMIT ?',
    args: [limite]
  });
  return result.rows;
};

export const guardarSuscripcionPush = async ({ token, subscription }) => {
  await db.execute({
    sql: 'UPDATE pedidos SET subscription_data = ? WHERE token = ?',
    args: [JSON.stringify(subscription), token]
  });
};

export const obtenerSuscripcionPush = async (token) => {
  const result = await db.execute({
    sql: 'SELECT subscription_data FROM pedidos WHERE token = ?',
    args: [token]
  });
  const pedido = result.rows[0];
  return pedido?.subscription_data ? JSON.parse(pedido.subscription_data) : null;
};

export const limpiarPedidosAntiguos = async () => {
  const result = await db.execute(`
    DELETE FROM pedidos 
    WHERE estado = 'retirado' 
    AND timestamp_retiro < datetime('now', '-24 hours')
  `);
  console.log(`🧹 Limpieza: ${result.rowsAffected} pedidos antiguos eliminados`);
  return result.rowsAffected;
};

export default db;