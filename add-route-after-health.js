const fs = require('fs');

console.log('🔧 ADDING STORE ROUTE AFTER HEALTH');
console.log('===================================');

let serverCode = fs.readFileSync('server.js', 'utf8');

// Remove any existing store route
serverCode = serverCode.replace(/\/\/ Store check-in endpoint[\s\S]*?}\);/g, '');

// Find the health route closing brace and add our route after it
const healthRoutePattern = /(app\.get\('\/health'[\s\S]*?}\);)/;
const match = serverCode.match(healthRoutePattern);

if (match) {
  const storeRoute = `

// Store check-in endpoint
app.post('/api/stores/checkin', authenticateToken, async (req, res) => {
  try {
    const { storeId } = req.body;
    const userId = req.user.userId;
    
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
});`;

  const updatedCode = serverCode.replace(healthRoutePattern, match[1] + storeRoute);
  
  fs.writeFileSync('server.js.backup-before-health-placement', serverCode);
  fs.writeFileSync('server.js', updatedCode);
  
  console.log('✅ Added store route after health route');
  console.log('🔄 Server should restart automatically');
} else {
  console.log('❌ Could not find health route');
}
