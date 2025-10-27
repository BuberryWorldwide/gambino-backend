// Add missing authenticateUser middleware
const fs = require('fs');

console.log('🔧 ADDING MISSING authenticateUser MIDDLEWARE');
console.log('==============================================');

let serverCode = fs.readFileSync('server.js', 'utf8');

// Find the authenticateAdmin function and add authenticateUser after it
const authenticateAdminPattern = /const authenticateAdmin = \(req, res, next\) => \{[\s\S]*?\};/;
const match = serverCode.match(authenticateAdminPattern);

if (match) {
  const authenticateUserMiddleware = `

// Authenticate regular users
const authenticateUser = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    
    // For user tokens, we expect userId in the payload
    if (!decoded.userId) {
      return res.status(401).json({ error: 'Invalid user token' });
    }
    
    // Add user info to request (you may want to fetch full user from DB)
    req.user = { _id: decoded.userId, walletAddress: decoded.walletAddress, email: decoded.email };
    req.userId = decoded.userId;
    
    next();
  } catch (error) {
    console.error('User auth error:', error.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};`;

  // Insert after authenticateAdmin
  const insertionPoint = match.index + match[0].length;
  const beforeInsertion = serverCode.substring(0, insertionPoint);
  const afterInsertion = serverCode.substring(insertionPoint);
  
  const updatedCode = beforeInsertion + authenticateUserMiddleware + afterInsertion;
  
  fs.writeFileSync('server.js.backup-before-auth-user', serverCode);
  fs.writeFileSync('server.js', updatedCode);
  
  console.log('✅ Added authenticateUser middleware');
  console.log('🔄 Server should restart automatically');
} else {
  console.log('❌ Could not find authenticateAdmin function to insert after');
}
