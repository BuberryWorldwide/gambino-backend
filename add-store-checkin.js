// Add store check-in endpoints to server.js
const fs = require('fs');

console.log('🏪 ADDING STORE CHECK-IN SYSTEM');
console.log('===============================');

let serverCode = fs.readFileSync('server.js', 'utf8');

// Add store check-in endpoints before the final closing braces
const newEndpoints = `

// ===== STORE CHECK-IN SYSTEM =====

// User checks into a store
app.post('/api/stores/checkin', authenticateUser, async (req, res) => {
  try {
    const { storeId } = req.body;
    const userId = req.user._id;
    
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID required' });
    }
    
    // Update user's current location and check-in time
    await User.findByIdAndUpdate(userId, {
      currentStore: storeId,
      checkedInAt: new Date(),
      lastActivity: new Date()
    });
    
    console.log(\`✅ User \${req.user.email} checked into store \${storeId}\`);
    
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

// User checks out of store
app.post('/api/stores/checkout', authenticateUser, async (req, res) => {
  try {
    const userId = req.user._id;
    
    await User.findByIdAndUpdate(userId, {
      currentStore: null,
      checkedInAt: null,
      lastActivity: new Date()
    });
    
    console.log(\`👋 User \${req.user.email} checked out of store\`);
    
    res.json({
      success: true,
      message: 'Checked out successfully'
    });
    
  } catch (error) {
    console.error('Store check-out error:', error);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

// Store admin gets active users in their store
app.get('/api/stores/:storeId/active-users', authenticateAdmin, async (req, res) => {
  try {
    const { storeId } = req.params;
    
    // Check if admin has access to this store
    if (req.admin.role !== 'super_admin' && !req.admin.assignedStores?.includes(storeId)) {
      return res.status(403).json({ error: 'Access denied to this store' });
    }
    
    // Find users currently checked into this store (last 4 hours)
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    
    const activeUsers = await User.find({
      currentStore: storeId,
      checkedInAt: { $gte: fourHoursAgo }
    }).select('firstName lastName email walletAddress gambinoBalance checkedInAt currentMachine');
    
    console.log(\`📋 Store \${storeId} has \${activeUsers.length} active users\`);
    
    res.json({
      success: true,
      storeId,
      activeUsers,
      count: activeUsers.length
    });
    
  } catch (error) {
    console.error('Get active users error:', error);
    res.status(500).json({ error: 'Failed to get active users' });
  }
});
`;

// Find a good place to insert the endpoints (before the server start)
const serverStartPattern = /app\.listen\(|server\.listen\(/;
const insertionPoint = serverCode.search(serverStartPattern);

if (insertionPoint !== -1) {
  const beforeStart = serverCode.substring(0, insertionPoint);
  const afterStart = serverCode.substring(insertionPoint);
  
  const updatedCode = beforeStart + newEndpoints + '\n' + afterStart;
  
  fs.writeFileSync('server.js.backup-before-checkin', serverCode);
  fs.writeFileSync('server.js', updatedCode);
  
  console.log('✅ Added store check-in endpoints');
  console.log('🔄 Server should restart with nodemon');
} else {
  console.log('❌ Could not find server start pattern');
}
