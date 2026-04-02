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

// ===== SEGURIDAD: Helmet (Headers HTTP seguros) =====
app.use(helmet({
  contentSecurityPolicy: false, // Desactivar para permitir scripts inline si es necesario
  crossOriginEmbedderPolicy: false
}));

// ===== SEGURIDAD: CORS configurado =====
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:10000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ===== SEGURIDAD: Rate Limiting (Prevenir fuerza bruta) =====
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 intentos por ventana
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

// ===== SEGURIDAD: Session Configuration =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-esto-por-un-secreto-muy-largo',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // false en desarrollo
    httpOnly: true,
    sameSite: 'lax',
    maxAge: parseInt(process.env.SESSION_EXPIRY) || 2 * 60 * 60 * 1000,
    path: '/'
  },
  name: 'mister-grill-session',
  store: undefined // En producción, usar connect-pg-simple o similar
}));

// ===== Middleware de autenticación global =====
app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session?.isAuthenticated || false;
  res.locals.user = req.session?.user || null;
  next();
});

// ============================================
//  RUTAS PÚBLICAS (Sin autenticación)
// ============================================

// Página de pedido del cliente
app.get('/pedido', (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/index.html'));
});

// Config VAPID (público, solo clave pública)
app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY });
});

// Health check (público)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ============================================
// 🔑 RUTAS DE AUTENTICACIÓN
// ============================================

// Página de login
app.get('/login', (req, res) => {
  // Si ya está autenticado, redirigir al panel
  if (req.session?.isAuthenticated) {
    return res.redirect('/cocina');
  }
  res.sendFile(join(__dirname, '../frontend/public/login.html'));
});

// POST Login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('🔍 [LOGIN] Intento de acceso:', { username, ip: req.ip });
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    // ✅ DEFINIR usuarios AQUÍ (dentro del endpoint)
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
    ].filter(u => u.username && u.hash); // Filtrar usuarios sin credentials
    
    console.log('🔍 [LOGIN] Usuarios configurados:', usuarios.map(u => u.username));
    
    // Buscar usuario
    const usuarioEncontrado = usuarios.find(u => u.username === username);
    
    if (!usuarioEncontrado) {
      console.log(`⚠️ [LOGIN] Usuario no encontrado: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    // Verificar contraseña con bcrypt
    const passwordValid = await bcrypt.compare(password, usuarioEncontrado.hash);
    
    if (!passwordValid) {
      console.log(`⚠️ [LOGIN] Contraseña inválida para: ${username}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    // ✅ Login exitoso - Crear sesión
    req.session.isAuthenticated = true;
    req.session.user = {
      username: usuarioEncontrado.username,
      role: usuarioEncontrado.role,
      loginTime: new Date().toISOString()
    };
    
    // ✅ Guardar sesión explícitamente
    req.session.save((err) => {
      if (err) {
        console.error('❌ [LOGIN] Error guardando sesión:', err);
        return res.status(500).json({ error: 'Error guardando sesión' });
      }
      
      console.log(`✅ [LOGIN] Éxito: ${usuarioEncontrado.username} (${usuarioEncontrado.role})`);
      console.log(`✅ [LOGIN] Session ID: ${req.sessionID}`);
      
      res.json({ 
        success: true, 
        message: 'Login exitoso',
        redirect: '/cocina'
      });
    });
    
  } catch (error) {
    console.error('❌ [LOGIN] Error crítico:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST Logout
// 🔐 POST Logout
app.post('/api/logout', (req, res) => {
  const username = req.session?.user?.username;
  
  req.session.destroy((err) => {
    if (err) {
      console.error('Error cerrando sesión:', err);
      return res.status(500).json({ error: 'Error cerrando sesión' });
    }
    
    // Limpiar cookie
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

// Verificar estado de sesión
app.get('/api/auth/status', (req, res) => {
  res.json({
    isAuthenticated: req.session?.isAuthenticated || false,
    user: req.session?.user || null
  });
});

// ============================================
// 🔒 RUTAS PROTEGIDAS (Requieren autenticación)
// ============================================

// Importar middleware
import { requireAuth } from './middleware/auth.js';

// Panel de cocina (PROTEGIDO)
app.get('/cocina', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/cocina.html'));
});

// Crear pedido (PROTEGIDO)
app.get('/crear-pedido', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, '../frontend/public/crear-pedido.html'));
});

// API: Crear nuevo pedido con QR (PROTEGIDO)
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
    
    // ✅ Generar número secuencial persistente
    const numero = generarNumeroPedido();
    const creadoPor = req.session.user?.username;
    
    // ✅ Guardar en base de datos
    crearPedido({ token, numero, creadoPor });
    
    console.log(`🆕 Pedido creado: ${numero} por ${creadoPor}`);
    
    res.json({
      success: true,
      pedidoNumero: numero,  // Ej: 20260401-001
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

// API: Listar pedidos (PROTEGIDO)
app.get('/api/pedidos', requireAuth, (req, res) => {
  const { filtro = 'todos' } = req.query;
  
  const pedidos = listarPedidos({ filtro });
  
  // Formatear respuesta
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
  
  res.json({ 
    success: true, 
    total: pedidosFormateados.length, 
    pedidos: pedidosFormateados 
  });
});

// API: Marcar pedido como LISTO (PROTEGIDO)
app.post('/api/pedido/:token/listo', requireAuth, async (req, res) => {
  const { token } = req.params;
  const pedido = obtenerPedido(token);
  
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido no encontrado' });
  }
  
  // ✅ Actualizar en base de datos
  actualizarEstadoPedido({ 
    token, 
    estado: 'listo', 
    marcadoPor: req.session.user?.username,
    campoTimestamp: 'listo'
  });
  
  // ✅ Enviar notificación push si existe suscripción
  const subscription = obtenerSuscripcionPush(token);
  
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
    } catch (error) {
      console.error('❌ Error enviando push:', error.body || error);
    }
  }
  
  res.json({ success: true, estado: 'listo', numero: pedido.numero });
});

// API: Marcar pedido como RETIRADO (PROTEGIDO)
app.post('/api/pedido/:token/retirado', requireAuth, (req, res) => {
  const { token } = req.params;
  const pedido = obtenerPedido(token);
  
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido no encontrado' });
  }
  
  actualizarEstadoPedido({ 
    token, 
    estado: 'retirado', 
    marcadoPor: req.session.user?.username,
    campoTimestamp: 'retiro'
  });
  
  console.log(`✅ Pedido #${pedido.numero} marcado como RETIRADO por ${req.session.user?.username}`);
  res.json({ success: true, estado: 'retirado', numero: pedido.numero });
});

// Consultar estado de pedido (público con token)
app.get('/api/pedido/:token', (req, res) => {
  const { token } = req.params;
  const pedido = obtenerPedido(token);
  
  if (pedido) {
    res.json({
      estado: pedido.estado,
      timestamp: pedido.timestamp,
      numero: pedido.numero  // Ej: 20260401-001
    });
  } else {
    res.json({ 
      estado: 'no_encontrado', 
      timestamp: new Date(),
      numero: null 
    });
  }
});

// API: Suscribirse a push (PÚBLICO - los clientes necesitan esto)
app.post('/api/subscribe', async (req, res) => {
  const { pedidoToken, subscription } = req.body;
  
  if (!pedidoToken || !subscription) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  
  // ✅ Guardar en base de datos
  guardarSuscripcionPush({ token: pedidoToken, subscription });
  
  console.log(`✅ Suscripción guardada: ${pedidoToken}`);
  res.json({ success: true });
});

// API: Limpiar pedidos antiguos (PROTEGIDO)
app.post('/api/pedidos/limpiar', requireAuth, (req, res) => {
  try {
    const eliminados = limpiarPedidosAntiguos();
    res.json({ success: true, eliminados });
  } catch (error) {
    console.error('❌ Error en limpieza:', error);
    res.status(500).json({ error: 'Error en limpieza' });
  }
});

// 🧹 Limpieza automática cada hora
setInterval(() => {
  try {
    limpiarPedidosAntiguos();
  } catch (err) {
    console.error('❌ Error en limpieza automática:', err);
  }
}, 60 * 60 * 1000); // Cada hora

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