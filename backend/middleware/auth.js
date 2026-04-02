// middleware/auth.js
export const requireAuth = (req, res, next) => {
  // Verificar si la sesión existe y está autenticada
  if (req.session && req.session.isAuthenticated) {
    return next();
  }
  
  // Si es una petición API, devolver JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ 
      error: 'No autorizado', 
      message: 'Debe iniciar sesión para acceder a este recurso' 
    });
  }
  
  // Si es una página, redirigir al login
  res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
};

export const isAuth = (req, res, next) => {
  // Solo verifica si está autenticado, no bloquea
  res.locals.isAuthenticated = req.session?.isAuthenticated || false;
  res.locals.user = req.session?.user || null;
  next();
};