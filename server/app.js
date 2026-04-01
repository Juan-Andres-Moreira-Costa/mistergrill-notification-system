// server/app.js
import express from 'express';
import webpush from 'web-push';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import crypto from 'crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Configurar VAPID
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Store en memoria (reemplazar con DB en producción)
const suscripciones = new Map(); // token -> subscription
const estados = new Map(); // token -> { estado, timestamp }

// 🎨 Servir página de creación de pedidos
app.get('/crear-pedido', (req, res) => {
  res.sendFile(join(__dirname, '../public/crear-pedido.html'));
});

// 📥 Suscribirse a push
app.post('/api/subscribe', async (req, res) => {
  const { pedidoToken, subscription } = req.body;
  
  if (!pedidoToken || !subscription) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  
  suscripciones.set(pedidoToken, subscription);
  console.log(`✅ Suscripción guardada: ${pedidoToken.slice(0, 8)}...`);
  
  res.json({ success: true });
});

// 📤 Marcar pedido como LISTO - MODIFICADO
app.post('/api/pedido/:token/listo', async (req, res) => {
  const { token } = req.params;
  const pedido = estados.get(token);  // ← Obtener datos del pedido
  
  // Actualizar estado
  estados.set(token, { 
    estado: 'listo', 
    timestamp: new Date(),
    numero: pedido?.numero  // ← Mantener el número
  });
  
  // Enviar notificación push si existe suscripción
  const subscription = suscripciones.get(token);
  
  if (subscription) {
    try {
      const payload = JSON.stringify({
  title: `🎉 Pedido #${pedido?.numero || 'LISTO'}`,
  body: `Retirá en barra - Tu pedido está listo`,
  icon: '/icons/icon-192.png',
  url: `/pedido?token=${token}`,
  numero: pedido?.numero,
  // 🔔 Propiedades para mejor entrega
  priority: 'high',
  visibility: 'public',
  wakeLock: true
});
      
      await webpush.sendNotification(subscription, payload, {
  TTL: 300,  // Tiempo de vida: 5 minutos
  urgency: 'high'  // Prioridad alta para entregar incluso en reposo
});
      console.log(`🔔 Push enviado: Pedido #${pedido?.numero} (${token.slice(0, 8)}...)`);
    } catch (error) {
      console.error('❌ Error enviando push:', error.body || error);
      if (error.statusCode === 410) {
        suscripciones.delete(token);
      }
    }
  } else {
    console.log(`⚠️ Sin suscripción para: ${token.slice(0, 8)}...`);
  }
  
  res.json({ success: true, estado: 'listo' });
});

app.get('/api/config', (req, res) => {
  res.json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY
  });
});

// 🆕 Endpoint: Crear nuevo pedido con QR
app.get('/api/pedido/crear', async (req, res) => {
  console.log('🎯 [DEBUG] Endpoint /crear HIT!');
  try {
    // 1. Generar token único y seguro (URL-safe)
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    
    // 2. URL que tendrá el QR (ajustar según tu dominio en producción)
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const pedidoUrl = `${baseUrl}/pedido?token=${token}`;
    
    // 3. Generar imagen QR en base64 (para mostrar en HTML o imprimir)
    const qrImage = await QRCode.toDataURL(pedidoUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',  // Color del QR
        light: '#FFFFFF'  // Fondo
      }
    });
    
    // 4. Guardar estado inicial del pedido (en memoria para MVP)
    estados.set(token, { 
      estado: 'preparacion', 
      timestamp: new Date(),
      numero: Math.floor(1000 + Math.random() * 9000) // Número visible para cocina
    });
    
    console.log(`🆕 Pedido creado: #${estados.get(token).numero} (token: ${token})`);
    
    // 5. Responder con datos para mostrar
    res.json({
      success: true,
      pedidoNumero: estados.get(token).numero,
      token,
      qrImage,          // DataURL para <img src="">
      pedidoUrl,        // URL para compartir o debug
      estado: 'preparacion'
    });
    
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    res.status(500).json({ error: 'Error generando QR', details: error.message });
  }
});

// 🔄 Consultar estado (para polling)
app.get('/api/pedido/:token', (req, res) => {
  const { token } = req.params;
  const pedido = estados.get(token);
  
  if (pedido) {
    res.json({
      estado: pedido.estado,
      timestamp: pedido.timestamp,
      numero: pedido.numero 
    });
  } else {
    res.json({ 
      estado: 'preparacion', 
      timestamp: new Date(),
      numero: null  
    });
  }
});

// 📋 Listar todos los pedidos (para panel de cocina)
app.get('/api/pedidos', (req, res) => {
  const { filtro } = req.query; // 'todos', 'preparacion', 'listo', 'retirado'
  
  const pedidos = [];
  
  for (const [token, data] of estados.entries()) {
    const pedido = {
      token,
      numero: data.numero,
      estado: data.estado,
      timestamp: data.timestamp,
      creadoHace: Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 1000 / 60) // minutos
    };
    pedidos.push(pedido);
  }
  
  // Ordenar por más reciente primero
  pedidos.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Aplicar filtro si existe
  let pedidosFiltrados = pedidos;
  if (filtro && filtro !== 'todos') {
    pedidosFiltrados = pedidos.filter(p => p.estado === filtro);
  }
  
  res.json({
    success: true,
    total: pedidos.length,
    pedidos: pedidosFiltrados
  });
});

app.post('/api/pedido/:token/retirado', async (req, res) => {
  const { token } = req.params;
  const pedido = estados.get(token);
  
  if (!pedido) {
    return res.status(404).json({ error: 'Pedido no encontrado' });
  }
  
  // Actualizar estado
  estados.set(token, { 
    ...pedido,
    estado: 'retirado', 
    timestampRetiro: new Date()
  });
  
  console.log(`✅ Pedido #${pedido.numero} marcado como RETIRADO`);
  
  res.json({ success: true, estado: 'retirado' });
});

// 🧹 Limpiar pedidos retirados (más de 1 hora)
app.post('/api/pedidos/limpiar', (req, res) => {
  const ahora = Date.now();
  const unaHora = 60 * 60 * 1000;
  let eliminados = 0;
  
  for (const [token, data] of estados.entries()) {
    if (data.estado === 'retirado') {
      const tiempoRetiro = ahora - new Date(data.timestampRetiro).getTime();
      if (tiempoRetiro > unaHora) {
        estados.delete(token);
        eliminados++;
      }
    }
  }
  
  console.log(`🧹 Limpieza: ${eliminados} pedidos eliminados`);
  res.json({ success: true, eliminados });
});

// 🎨 Servir página de pedido
app.get('/pedido', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});


// 🚀 Endpoint de salud
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// 🍳 Servir panel de cocina
app.get('/cocina', (req, res) => {
  res.sendFile(join(__dirname, '../public/cocina.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📱 Probá en móvil: http://<tu-ip-local>:${PORT}/pedido?token=test123`);
});