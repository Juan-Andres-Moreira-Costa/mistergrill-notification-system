// generate-password-hash.js
// Ejecutar: node generate-password-hash.js
import bcrypt from 'bcryptjs';

const passwords = [
  'MisterGrill2026!',  // Contraseña para administrador
  'Caja123!'           // Contraseña para cajero
];

console.log('🔐 Generando hashes de contraseñas...\n');

passwords.forEach(async (password, index) => {
  const salt = await bcrypt.genSalt(12);
  const hash = await bcrypt.hash(password, salt);
  console.log(`Contraseña ${index + 1}: ${password}`);
  console.log(`Hash: ${hash}\n`);
  console.log('---\n');
});