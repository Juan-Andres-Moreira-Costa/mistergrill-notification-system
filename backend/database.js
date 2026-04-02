// backend/database.js
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Crear/abrir base de datos
const db = new Database(join(__dirname, 'mister-grill.db'));

// Crear tablas si no existen
db.exec(`
  -- Tabla de pedidos
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
    subscription_data TEXT  -- Para notificaciones push
  );
  
  -- Índice para búsquedas por estado
  CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);
  CREATE INDEX IF NOT EXISTS idx_pedidos_timestamp ON pedidos(timestamp);
  
  -- Tabla de contadores diarios
  CREATE TABLE IF NOT EXISTS contadores (
    fecha TEXT PRIMARY KEY,  -- Formato: AAAAMMDD
    ultimo_numero INTEGER DEFAULT 0,
    reseteado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ===== FUNCIONES DE UTILIDAD =====

// Obtener fecha en formato AAAAMMDD
export const getFechaHoy = () => {
  const ahora = new Date();
  const año = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${año}${mes}${dia}`;
};

// Obtener o crear contador para hoy
export const obtenerContadorHoy = () => {
  const fecha = getFechaHoy();
  
  let contador = db.prepare('SELECT ultimo_numero FROM contadores WHERE fecha = ?').get(fecha);
  
  if (!contador) {
    // Crear nuevo contador para hoy
    db.prepare('INSERT INTO contadores (fecha, ultimo_numero) VALUES (?, 0)').run(fecha);
    return 0;
  }
  
  return contador.ultimo_numero;
};

// Incrementar contador y devolver nuevo número
export const siguienteNumeroPedido = () => {
  const fecha = getFechaHoy();
  
  // Usar transacción para evitar condiciones de carrera
  const stmt = db.prepare(`
    UPDATE contadores 
    SET ultimo_numero = ultimo_numero + 1,
        reseteado_en = CURRENT_TIMESTAMP
    WHERE fecha = ?
    RETURNING ultimo_numero
  `);
  
  const result = stmt.get(fecha);
  
  if (!result) {
    // Si no existe, crear y devolver 1
    db.prepare('INSERT INTO contadores (fecha, ultimo_numero) VALUES (?, 1)').run(fecha);
    return 1;
  }
  
  return result.ultimo_numero;
};

// Generar número de pedido con formato: AAAAMMDD-001
export const generarNumeroPedido = () => {
  const fecha = getFechaHoy();
  const consecutivo = siguienteNumeroPedido().toString().padStart(3, '0');
  return `${fecha}-${consecutivo}`;
};

// ===== CRUD DE PEDIDOS =====

export const crearPedido = ({ token, numero, creadoPor, subscriptionData = null }) => {
  const stmt = db.prepare(`
    INSERT INTO pedidos (token, numero, estado, creado_por, subscription_data)
    VALUES (?, ?, 'preparacion', ?, ?)
  `);
  return stmt.run(token, numero, creadoPor, subscriptionData ? JSON.stringify(subscriptionData) : null);
};

export const obtenerPedido = (token) => {
  return db.prepare('SELECT * FROM pedidos WHERE token = ?').get(token);
};

export const actualizarEstadoPedido = ({ token, estado, marcadoPor, campoTimestamp }) => {
  const updates = ['estado = ?'];
  const params = [estado]; // ← solo 'estado' al inicio, token va al final UNA sola vez
  
  if (marcadoPor) {
    updates.push('marcado_listo_por = ?');
    params.push(marcadoPor);
  }
  
  if (campoTimestamp === 'listo') {
    updates.push('timestamp_listo = CURRENT_TIMESTAMP'); // sin ? porque no necesita param
  } else if (campoTimestamp === 'retiro') {
    updates.push('timestamp_retiro = CURRENT_TIMESTAMP'); // ídem
  }
  
  params.push(token); // ← token se agrega UNA sola vez, al final
  
  const stmt = db.prepare(`
    UPDATE pedidos 
    SET ${updates.join(', ')}
    WHERE token = ?
  `);
  
  return stmt.run(...params);
};

export const listarPedidos = ({ filtro = 'todos', limite = 50 } = {}) => {
  let query = 'SELECT * FROM pedidos';
  const params = [];
  
  if (filtro && filtro !== 'todos') {
    query += ' WHERE estado = ?';
    params.push(filtro);
  }
  
  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limite);
  
  return db.prepare(query).all(...params);
};

export const guardarSuscripcionPush = ({ token, subscription }) => {
  const stmt = db.prepare(`
    UPDATE pedidos 
    SET subscription_data = ?
    WHERE token = ?
  `);
  return stmt.run(JSON.stringify(subscription), token);
};

export const obtenerSuscripcionPush = (token) => {
  const pedido = db.prepare('SELECT subscription_data FROM pedidos WHERE token = ?').get(token);
  return pedido?.subscription_data ? JSON.parse(pedido.subscription_data) : null;
};

// Limpieza: eliminar pedidos retirados de hace más de 24h
export const limpiarPedidosAntiguos = () => {
  const stmt = db.prepare(`
    DELETE FROM pedidos 
    WHERE estado = 'retirado' 
    AND timestamp_retiro < datetime('now', '-24 hours')
  `);
  const result = stmt.run();
  console.log(`🧹 Limpieza: ${result.changes} pedidos antiguos eliminados`);
  return result.changes;
};

export default db;