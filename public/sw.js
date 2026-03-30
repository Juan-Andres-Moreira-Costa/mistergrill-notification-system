// ============================================
// public/sw.js - Service Worker (SIN IMPORTS)
// ============================================
// ⚠️ ESTE ARCHIVO NO PUEDE TENER: import, export, type="module"

// 🔧 Evento: Instalación
self.addEventListener('install', (event) => {
  console.log('[SW] ✅ Instalado');
  self.skipWaiting();
});

// 🔧 Evento: Activación
self.addEventListener('activate', (event) => {
  console.log('[SW] ✅ Activado');
  return self.clients.claim();
});

// 🔔 Evento: Push recibido
self.addEventListener('push', (event) => {
  // Datos por defecto
  let notificationData = {
    title: '🍔 Tu pedido está listo',
    body: 'Acercate a la barra para retirar',
    url: '/'
  };

  // Intentar leer datos del push si existen
  if (event.data) {
    try {
      const jsonData = event.data.json();
      notificationData = { ...notificationData, ...jsonData };
    } catch (e) {
      console.warn('[SW] ⚠️ No se pudo parsear data del push:', e);
    }
  }

  // Mostrar notificación
  event.waitUntil(
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: data.icon,
        badge: data.icon,
        Vibrate: [200, 100, 200],
        data: { url: data.url },
    actions: [
      { action: 'Abrir', title: 'Ver Detalles' }
    ]
  })
);
});

// 👆 Evento: Usuario hace clic en la notificación
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Buscar ventana existente de /pedido
        for (const client of clientList) {
          if (client.url.includes('/pedido') && 'focus' in client) {
            return client.focus();
          }
        }
        // Abrir nueva ventana con la URL que venga en notification.data
        if (clients.openWindow) {
          // ✅ CORRECCIÓN: Usar event.notification.data directamente
          const targetUrl = event.notification.data?.url || '/';
          return clients.openWindow(targetUrl);
        }
      })
  );
});
