// Script to add luck routes to server.js
const fs = require('fs');

const serverPath = '/opt/gambino/backend/server.js';
const backupPath = `/opt/gambino/backend/server.js.backup-luck-${Date.now()}`;

// Read server.js
let content = fs.readFileSync(serverPath, 'utf8');

// Create backup
fs.writeFileSync(backupPath, content);
console.log(`Backup created: ${backupPath}`);

// The luck routes code to add
const luckRoutesCode = `
// ===== PROOF OF LUCK ROUTES =====
// Gambino's luck system - consumes Arca entropy draw API
const { router: luckRouter, setupLuckRoutes } = require('./src/routes/luck');
const luckService = require('./src/services/LuckService');

// Setup luck routes with dependencies
setupLuckRoutes({
  authenticate,
  luckService,
  User
});

app.use('/api/luck', luckRouter);
console.log('✅ Luck routes registered at /api/luck');

`;

// Find the marker to insert before
const marker = '// ============================================\n// MongoDB Connection & Server Startup';

if (!content.includes(marker)) {
  console.error('Could not find insertion marker in server.js');
  process.exit(1);
}

// Check if luck routes already exist
if (content.includes('/api/luck')) {
  console.log('Luck routes already exist in server.js');
  process.exit(0);
}

// Insert luck routes before MongoDB connection section
content = content.replace(marker, luckRoutesCode + marker);

// Write updated server.js
fs.writeFileSync(serverPath, content);
console.log('✅ Luck routes added to server.js');
