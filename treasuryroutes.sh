#!/bin/bash
# Fix missing blockchainTreasuryRoutes

cd /opt/gambino/backend

echo "🔧 Fixing missing blockchainTreasuryRoutes..."

# First, check if the file exists
if [ ! -f "src/routes/blockchainTreasuryRoutes.js" ]; then
    echo "❌ blockchainTreasuryRoutes.js missing, creating placeholder..."
    
    # Create the missing directories
    mkdir -p src/routes
    
    # Create a minimal placeholder routes file
    cat > src/routes/blockchainTreasuryRoutes.js << 'EOF'
// blockchainTreasuryRoutes.js - Minimal placeholder

const express = require('express');
const router = express.Router();

// Health check for blockchain treasury
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Blockchain treasury routes online',
    timestamp: new Date().toISOString()
  });
});

// Placeholder for future treasury endpoints
router.get('/status', (req, res) => {
  res.json({
    success: true,
    message: 'Treasury status endpoint - coming soon',
    data: {
      status: 'offline',
      message: 'Treasury service not yet implemented'
    }
  });
});

module.exports = router;
EOF
    
    echo "✅ Created placeholder blockchainTreasuryRoutes.js"
else
    echo "✅ blockchainTreasuryRoutes.js already exists"
fi

# Now fix the require statement in server.js
echo "🔧 Checking server.js require statement..."

# Check if the require line exists and is correct
if grep -q "const blockchainTreasuryRoutes = require('./src/routes/blockchainTreasuryRoutes');" server.js; then
    echo "✅ Require statement looks correct"
elif grep -q "blockchainTreasuryRoutes" server.js; then
    echo "🔧 Fixing require statement..."
    
    # Backup server.js
    cp server.js server.js.backup-blockchain-fix
    
    # Fix the require statement
    sed -i 's|const blockchainTreasuryRoutes.*|const blockchainTreasuryRoutes = require("./src/routes/blockchainTreasuryRoutes");|g' server.js
    
    echo "✅ Fixed require statement"
else
    echo "🔧 Adding missing require statement..."
    
    # Backup server.js
    cp server.js server.js.backup-blockchain-fix
    
    # Add the require statement after other requires
    sed -i '/const adminAuth = require/a const blockchainTreasuryRoutes = require("./src/routes/blockchainTreasuryRoutes");' server.js
    
    echo "✅ Added require statement"
fi

echo ""
echo "✅ Fixed blockchainTreasuryRoutes issue!"
echo "🔄 Try starting the server now: npm start"
