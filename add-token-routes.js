const fs = require('fs');

const serverPath = './server.js';
let content = fs.readFileSync(serverPath, 'utf8');

// Find where routes are mounted and add token routes
const tokenRoute = "\n// Token refresh routes for Pi auto-renewal\napp.use('/api/token', require('./src/routes/token-refresh'));\n";

// Add after other API routes
if (!content.includes('/api/token')) {
  content = content.replace(
    /app\.use\('\/api\/hubs', hubRoutes\);/,
    "app.use('/api/hubs', hubRoutes);" + tokenRoute
  );
  
  fs.writeFileSync(serverPath, content);
  console.log('✅ Token refresh routes added to server.js');
} else {
  console.log('ℹ️  Token routes already exist');
}
