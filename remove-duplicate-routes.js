// Remove duplicate store routes
const fs = require('fs');

console.log('🔧 REMOVING DUPLICATE ROUTES');
console.log('=============================');

let serverCode = fs.readFileSync('server.js', 'utf8');

// Count how many times the route appears
const routePattern = /app\.post\('\/api\/stores\/checkin'/g;
const matches = serverCode.match(routePattern);
console.log(`Found ${matches ? matches.length : 0} instances of the route`);

// Remove all instances of the store check-in system
serverCode = serverCode.replace(/\/\/ ===== STORE CHECK-IN SYSTEM =====[\s\S]*?}\);/g, '');

// Add one clean version before startServer
const insertBeforePattern = /\/\/ Start server\s*const startServer/;

const cleanStoreEndpoint = `
// ===== STORE CHECK-IN SYSTEM =====
app.post('/api/stores/checkin', authenticateUser, async (req, res) => {
  try {
    const { storeId } = req.body;
    const userId = req.user._id;
    
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID required' });
    }
    
    await User.findByIdAndUpdate(userId, {
      currentStore: storeId,
      checkedInAt: new Date(),
      lastActivity: new Date()
    });
    
    console.log(\`✅ User checked into store \${storeId}\`);
    
    res.json({
      success: true,
      message: 'Checked into store successfully',
      storeId,
      checkedInAt: new Date()
    });
    
  } catch (error) {
    console.error('Store check-in error:', error);
    res.status(500).json({ error: 'Failed to check into store' });
  }
});

`;

// Insert the clean version
const fixedCode = serverCode.replace(insertBeforePattern, cleanStoreEndpoint + '// Start server\nconst startServer');

fs.writeFileSync('server.js.backup-before-dedup', serverCode);
fs.writeFileSync('server.js', fixedCode);

console.log('✅ Removed duplicates and added one clean route');
console.log('🔄 Server should restart automatically');
