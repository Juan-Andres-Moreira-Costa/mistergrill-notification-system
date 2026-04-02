import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import webpush from 'web-push';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { requireAuth } from './middleware/auth.js';
import db, { 
  generarNumeroPedido, 
  crearPedido, 
  obtenerPedido, 
  actualizarEstadoPedido, 
  listarPedidos,
  guardarSuscripcionPush,
  obtenerSuscripcionPush,
  limpiarPedidosAntiguos
} from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ===== SEGURIDAD: Helmet =====
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// ===== SEGURIDAD: CORS =====
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:10000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ===== SEGURIDAD: Rate Limiting =====
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { 
    error: 'Demasiados intentos de login', 
    message: 'Por seguridad, intente nuevamente en 15 minutos' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== Middleware básico =====
app.use(express.json());
app.use(express.static(join(__dirname, '../frontend/public')));
app.use(express.urlencoded({ extended: true }));

// ===== SEGURIDAD: Session =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-esto-por-un-secreto-muy-largo',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: parseInt(process.env.SESSION_EXPIRY) || 2 * 60 * 60 * 1000,
    path: '/'
  },
  name: 'mister-grill-session',
}));

// ===== Middleware de autenticación global =====
app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session?.isAuthenticated || false;
  res.locals.user = req.session?.user || null;
  next();
});

// ============================================
//  RUTAS PÚBLICAS
// ============================================

app.get('/pedido', (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ============================================
// 🔑 AUTENTICACIÓN
// ============================================

app.get('/login', (req, res) => {
  if (req.session?.isAuthenticated) {
    return res.redirect('/cocina');
  }
  res.sendFile(join(__dirname, '../frontend/public/login.html'));
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('🔍 [LOGIN] Intento de acceso:', { username, ip: req.ip });
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    const usuarios = [
      { 
        username: process.env.STAFF_USERNAME_1, 
        hash: process.env.STAFF_PASSWORD_HASH_1, 
        role: 'administrador' 
      },
      { 
        username: process.env.STAFF_USERNAME_2, 
        hash: process.env.STAFF_PASSWORD_HASH_2, 
        role: 'cajero' 
      }
    ].filter(u => u.username && u.hash);
    
    const usuarioEncontrado = usuarios.find(u => u.username === username);
    
    if (!usuarioEncontrado) {
      console.log(`⚠️ [LOGIN] Usuario no encontrado: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    const passwordValid = await bcrypt.compare(password, usuarioEncontrado.hash);
    
    if (!passwordValid) {
      console.log(`⚠️ [LOGIN] Contraseña inválida para: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    req.session.isAuthenticated = true;
    req.session.user = {
      username: usuarioEncontrado.username,
      role: usuarioEncontrado.role,
      loginTime: new Date().toISOString()
    };
    
    req.session.save((err) => {
      if (err) {
        console.error('❌ [LOGIN] Error guardando sesión:', err);
        return res.status(500).json({ error: 'Error guardando sesión' });
      }
      
      console.log(`✅ [LOGIN] Éxito: ${usuarioEncontrado.username} (${usuarioEncontrado.role})`);
      res.json({ success: true, message: 'Login exitoso', redirect: '/cocina' });
    });
    
  } catch (error) {
    console.error('❌ [LOGIN] Error crítico:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/logout', (req, res) => {
  const username = req.session?.user?.username;
  
  req.session.destroy((err) => {
    if (err) {
      console.error('Error cerrando sesión:', err);
      return res.status(500).json({ error: 'Error cerrando sesión' });
    }
    
    res.clearCookie('mister-grill-session', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    
    console.log(`✅ Logout: ${username}`);
    res.json({ success: true, message: 'Sesión cerrada' });
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    isAuthenticated: req.session?.isAuthenticated || false,
    user: req.session?.user || null
  });
});

// ============================================
// 🔒 RUTAS PROTEGIDAS
// ============================================

app.get('/cocina', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/cocina.html'));
});

app.get('/crear-pedido', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/crear-pedido.html'));
});

// API: Crear nuevo pedido con QR
app.get('/api/pedido/crear', requireAuth, async (req, res) => {
  try {
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const baseUrl = process.env.BASE_URL || 'http://localhost:10000';
    const pedidoUrl = `${baseUrl}/pedido?token=${token}`;
    
    const qrImage = await QRCode.toDataURL(pedidoUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    
    const numero = await generarNumeroPedido(); // ✅ await
    const creadoPor = req.session.user?.username;
    
    await crearPedido({ token, numero, creadoPor }); // ✅ await
    
    console.log(`🆕 Pedido creado: ${numero} por ${creadoPor}`);
    
    res.json({
      success: true,
      pedidoNumero: numero,
      token,
      qrImage,
      pedidoUrl,
      estado: 'preparacion'
    });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: 'Error generando QR', details: error.message });
  }
});

// API: Listar pedidos
app.get('/api/pedidos', requireAuth, async (req, res) => { // ✅ async
  try {
    const { filtro = 'todos' } = req.query;
    
    const pedidos = await listarPedidos({ filtro }); // ✅ await
    
    const pedidosFormateados = pedidos.map(p => ({
      token: p.token,
      numero: p.numero,
      estado: p.estado,
      timestamp: p.timestamp,
      creadoHace: Math.floor((Date.now() - new Date(p.timestamp).getTime()) / 1000 / 60),
      creadoPor: p.creado_por,
      marcadoPor: p.marcado_listo_por,
      retiradoPor: p.retirado_por
    }));
    
    res.json({ success: true, total: pedidosFormateados.length, pedidos: pedidosFormateados });
  } catch (error) {
    console.error('❌ Error listando pedidos:', error);
    res.status(500).json({ error: 'Error obteniendo pedidos' });
  }
});

// API: Marcar pedido como LISTO
app.post('/api/pedido/:token/listo', requireAuth, async (req, res) => {
  try {
    const { token } = req.params;
    const pedido = await obtenerPedido(token); // ✅ await
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    await actualizarEstadoPedido({ // ✅ await
      token, 
      estado: 'listo', 
      marcadoPor: req.session.user?.username,
      campoTimestamp: 'listo'
    });
    
    const subscription = await obtenerSuscripcionPush(token); // ✅ await
    
    if (subscription) {
      try {
        const payload = JSON.stringify({
          title: `🎉 Pedido ${pedido.numero} LISTO`,
          body: `Retirá en barra - Mister Grill`,
          icon: '/icons/icon-192.png',
          url: `/pedido?token=${token}`,
          priority: 'high',
          urgency: 'high'
        });
        
        await webpush.sendNotification(subscription, payload, {
          TTL: 300,
          urgency: 'high'
        });
        console.log(`🔔 Push enviado: Pedido ${pedido.numero}`);
      } catch (pushError) {
        console.error('❌ Error enviando push:', pushError.body || pushError);
      }
    }
    
    res.json({ success: true, estado: 'listo', numero: pedido.numero });
  } catch (error) {
    console.error('❌ Error marcando listo:', error);
    res.status(500).json({ error: 'Error actualizando pedido' });
  }
});

// API: Marcar pedido como RETIRADO
app.post('/api/pedido/:token/retirado', requireAuth, async (req, res) => { // ✅ async
  try {
    const { token } = req.params;
    const pedido = await obtenerPedido(token); // ✅ await
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    await actualizarEstadoPedido({ // ✅ await
      token, 
      estado: 'retirado', 
      marcadoPor: req.session.user?.username,
      campoTimestamp: 'retiro'
    });
    
    console.log(`✅ Pedido #${pedido.numero} marcado como RETIRADO por ${req.session.user?.username}`);
    res.json({ success: true, estado: 'retirado', numero: pedido.numero });
  } catch (error) {
    console.error('❌ Error marcando retirado:', error);
    res.status(500).json({ error: 'Error actualizando pedido' });
  }
});

// Consultar estado de pedido (público)
app.get('/api/pedido/:token', async (req, res) => { // ✅ async
  try {
    const { token } = req.params;
    const pedido = await obtenerPedido(token); // ✅ await
    
    if (pedido) {
      res.json({
        estado: pedido.estado,
        timestamp: pedido.timestamp,
        numero: pedido.numero
      });
    } else {
      res.json({ estado: 'no_encontrado', timestamp: new Date(), numero: null });
    }
  } catch (error) {
    console.error('❌ Error consultando pedido:', error);
    res.status(500).json({ error: 'Error consultando pedido' });
  }
});

// API: Suscribirse a push (público)
app.post('/api/subscribe', async (req, res) => {
  try {
    const { pedidoToken, subscription } = req.body;
    
    if (!pedidoToken || !subscription) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    
    await guardarSuscripcionPush({ token: pedidoToken, subscription }); // ✅ await
    
    console.log(`✅ Suscripción guardada: ${pedidoToken}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error guardando suscripción:', error);
    res.status(500).json({ error: 'Error guardando suscripción' });
  }
});

// API: Limpiar pedidos antiguos (protegido)
app.post('/api/pedidos/limpiar', requireAuth, async (req, res) => { // ✅ async
  try {
    const eliminados = await limpiarPedidosAntiguos(); // ✅ await
    res.json({ success: true, eliminados });
  } catch (error) {
    console.error('❌ Error en limpieza:', error);
    res.status(500).json({ error: 'Error en limpieza' });
  }
});

// 🧹 Limpieza automática cada hora
setInterval(async () => {
  try {
    await limpiarPedidosAntiguos(); // ✅ await
  } catch (err) {
    console.error('❌ Error en limpieza automática:', err);
  }
}, 60 * 60 * 1000);

// Ejecutar limpieza al iniciar
limpiarPedidosAntiguos();

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`🔐 Panel de cocina: http://localhost:${PORT}/cocina (PROTEGIDO)`);
  console.log(`🔐 Crear pedido: http://localhost:${PORT}/crear-pedido (PROTEGIDO)`);
  console.log(`📱 Pedido cliente: http://localhost:${PORT}/pedido?token=xxx (PÚBLICO)`);
});