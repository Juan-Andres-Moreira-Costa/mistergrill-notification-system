// server/app.js
import express from 'express';
import webpush from 'web-push';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

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

// 📤 Marcar pedido como LISTO (desde panel de cocina)
app.post('/api/pedido/:token/listo', async (req, res) => {
  const { token } = req.params;
  
  // Actualizar estado
  estados.set(token, { estado: 'listo', timestamp: new Date() });
  
  // Enviar notificación push si existe suscripción
  const subscription = suscripciones.get(token);
  
  if (subscription) {
    try {
      const payload = JSON.stringify({
        title: '🎉 ¡Tu pedido está listo!',
        body: `Retirá en barra - Pedido #${token.slice(-4)}`,
        icon: '/icons/icon-192.png',
        url: `/pedido?token=${token}`
      });
      
      await webpush.sendNotification(subscription, payload);
      console.log(`🔔 Push enviado: ${token.slice(0, 8)}...`);
    } catch (error) {
      console.error('❌ Error enviando push:', error.body || error);
      // Si es 410 (Gone), la suscripción es inválida
      if (error.statusCode === 410) {
        suscripciones.delete(token);
      }
    }
  } else {
    console.log(`⚠️ Sin suscripción para: ${token.slice(0, 8)}...`);
  }
  
  res.json({ success: true, estado: 'listo' });
});

// 🔄 Consultar estado (para polling)
app.get('/api/pedido/:token', (req, res) => {
  const { token } = req.params;
  const estado = estados.get(token) || { estado: 'preparacion', timestamp: new Date() };
  res.json(estado);
});

app.get('/api/config', (req, res) => {
  res.json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY
  });
});

// 🎨 Servir página de pedido
app.get('/pedido', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

// 🚀 Endpoint de salud
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📱 Probá en móvil: http://<tu-ip-local>:${PORT}/pedido?token=test123`);
});