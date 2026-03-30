// 🔑 Obtener clave VAPID desde el backend
let VAPID_PUBLIC_KEY = null;

const loadVapidKey = async () => {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    VAPID_PUBLIC_KEY = config.vapidPublicKey;
    console.log('✅ Clave VAPID cargada');
    return true;
  } catch (err) {
    console.error('❌ Error cargando clave VAPID:', err);
    return false;
  }
};

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
};

const getPedidoToken = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
};

const actualizarUI = (estado) => {
  const el = document.getElementById('estado');
  if (estado === 'listo') {
    el.className = 'estado listo';
    el.textContent = '🎉 ¡Tu pedido está listo! Retirá en barra';
    
    // 🔊 Sonido opcional con fallback seguro
    try {
      const audio = new Audio('/sounds/notify.mp3');
      audio.play().catch((err) => {
        // Silenciar errores: sonido opcional
        console.log('[Audio] Sonido no disponible (opcional):', err.message);
      });
    } catch (e) {
      // Silenciar errores de creación de Audio
      console.log('[Audio] No se pudo crear el elemento de audio');
    }
  }
};

const registrarServiceWorker = async () => {
  console.log('[DEBUG] Iniciando registro de SW...');
  
  if (!('serviceWorker' in navigator)) {
    console.error('[DEBUG] ❌ Service Worker NO soportado');
    return null;
  }
  console.log('[DEBUG] ✅ Service Worker soportado');
  
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none'
    });
    console.log('[DEBUG] ✅ SW registrado con éxito:', reg.scope);
    return reg;
  } catch (err) {
    console.error('[DEBUG] ❌ Error registrando SW:', err.message);
    console.error('[DEBUG] Stack:', err.stack);
    return null;
  }
};

const solicitarPush = async (registration, token) => {
  if (!('PushManager' in window)) {
    console.warn('❌ Push API no soportada');
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('⚠️ Permiso de notificaciones denegado');
    return null;
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  // Enviar al backend
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pedidoToken: token, subscription })
  });

  if (!res.ok) throw new Error('Error al registrar suscripción');
  
  console.log('✅ Suscripción push registrada');
  return subscription;
};

const consultarEstado = async (token) => {
  try {
    const res = await fetch(`/api/pedido/${token}`);
    const data = await res.json();
    if (data.estado === 'listo') {
      actualizarUI('listo');
      return true; // pedido listo, podemos parar el polling
    }
  } catch (err) {
    console.error('Error consultando estado:', err);
  }
  return false;
};

const iniciarPolling = (token, intervalo = 30000) => {
  const id = setInterval(async () => {
    const listo = await consultarEstado(token);
    if (listo) {
      clearInterval(id);
      console.log('🎉 Pedido listo - polling detenido');
    }
  }, intervalo);
  return id;
};

document.addEventListener('DOMContentLoaded', async () => {
  // Primero cargar la clave VAPID
  const keyLoaded = await loadVapidKey();
  if (!keyLoaded) {
    document.getElementById('btn-push').disabled = true;
    document.getElementById('btn-push').textContent = '❌ Error de configuración';
    return;
  }

  const token = getPedidoToken();
  
  if (!token) {
    document.getElementById('token-display').textContent = 'Token no válido';
    document.getElementById('btn-push').disabled = true;
    return;
  }

  document.getElementById('token-display').textContent = token.slice(0, 8) + '...';
  
  // Consultar estado inicial
  await consultarEstado(token);
  
  // Configurar botón de push
  const btn = document.getElementById('btn-push');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Activando...';
    
    try {
      const reg = await registrarServiceWorker();
      if (reg) {
        await solicitarPush(reg, token);
        btn.textContent = '✅ Notificaciones activas';
        btn.style.background = '#10b981';
      }
    } catch (err) {
      console.error('Error activando push:', err);
      btn.textContent = '❌ Error. Intentá de nuevo';
      btn.disabled = false;
    }
  });

  // Polling de respaldo
  iniciarPolling(token);
});