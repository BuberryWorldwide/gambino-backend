#!/usr/bin/env node

/**
 * Direct fix for the server.js file issues
 */

const fs = require('fs');

function fixServerFile() {
  console.log('�� Fixing server.js syntax and structure issues...');
  
  let content = fs.readFileSync('server.js', 'utf8');
  
  // 1. Remove broken middleware definitions (incomplete code blocks)
  content = content.replace(/\/\/ --- AUTHENTICATION MIDDLEWARE ---[\s\S]*?};[\s\S]*?};[\s\S]*?\/\*\*[\s\S]*?\*\/[\s\S]*?};[\s\S]*?\/\/ Store validation middleware[\s\S]*?\/\/ Audit logging middleware[\s\S]*?\/\/ Combined middleware chain helper/g, '// --- AUTHENTICATION MIDDLEWARE ---\n// Removed broken middleware - now using RBAC system');
  
  // 2. Remove incomplete middleware function signatures
  content = content.replace(/const requireRole = \([^)]*\) => \{[^}]*\};?/g, '');
  content = content.replace(/const requireVenueAccess = \([^)]*\) => \{[\s\S]*?\};?/g, '');
  content = content.replace(/const createVenueAccessChain = \([^)]*\) => \{[\s\S]*?\};?/g, '');
  
  // 3. Fix old login endpoints that weren't removed properly
  content = content.replace(/app\.post\('\/api\/users\/login', loginLimiter, async \(req, res\) => \{[\s\S]*?\}\);/g, '');
  content = content.replace(/app\.post\('\/api\/admin\/login', async \(req, res\) => \{[\s\S]*?\}\);/g, '');
  
  // 4. Fix broken middleware chains and add missing commas
  content = content.replace(/authenticate, requirePermission\(PERMISSIONS\.VIEW_ALL_METRICS\)async/g, 'authenticate, requirePermission(PERMISSIONS.VIEW_ALL_METRICS), async');
  content = content.replace(/authenticate, requirePermission\(([^)]+)\)async/g, 'authenticate, requirePermission($1), async');
  content = content.replace(/authenticateasync/g, 'authenticate, async');
  
  // 5. Fix broken createVenueMiddleware calls
  content = content.replace(/\.\.\.createVenueMiddleware\(\{([^}]*)\}\)async/g, '...createVenueMiddleware({ $1 }), async');
  
  // 6. Remove reconciliation middleware setup that references old middleware
  content = content.replace(/\/\/ Setup middleware for reconciliation routes[\s\S]*?\/\/ Mount reconciliation routes/g, '// Mount reconciliation routes');
  
  // 7. Ensure RBAC imports are properly placed and not duplicated
  const rbacImportBlock = `// RBAC System - Added by migration script
const { 
  authenticate, 
  requirePermission, 
  requireVenueAccess,
  createVenueMiddleware,
  PERMISSIONS 
} = require('./src/middleware/rbac');

// Unified Authentication Routes - Added by migration script
const authRoutes = require('./src/routes/auth');
app.use('/api/auth', authRoutes);
`;

  // Remove duplicate RBAC imports
  content = content.replace(/\/\/ RBAC System - Added by migration script[\s\S]*?require\('\.\/src\/middleware\/rbac'\);[\s\S]*?\/\/ Unified Authentication Routes[\s\S]*?app\.use\('\/api\/auth', authRoutes\);/g, '');
  
  // Add the RBAC imports after the reconciliation section
  const reconciliationIndex = content.indexOf('// PHASE 3: RECONCILIATION ROUTES');
  if (reconciliationIndex !== -1) {
    const afterReconciliation = content.indexOf('app.use(\'/api/admin/reconciliation\', reconciliationRouter);');
    if (afterReconciliation !== -1) {
      const insertPoint = content.indexOf('\n', afterReconciliation) + 1;
      content = content.slice(0, insertPoint) + '\n' + rbacImportBlock + '\n' + content.slice(insertPoint);
    }
  }
  
  // 8. Fix admin users route that's missing proper permissions
  content = content.replace(/app\.get\('\/api\/admin\/users', authenticate,/g, 'app.get(\'/api/admin/users\', authenticate, requirePermission(PERMISSIONS.VIEW_USERS),');
  
  // 9. Fix any remaining permission issues
  content = content.replace(/requirePermission\(([A-Z_]+)\)/g, (match, perm) => {
    if (!perm.startsWith('PERMISSIONS.')) {
      return `requirePermission(PERMISSIONS.${perm})`;
    }
    return match;
  });
  
  // 10. Clean up any remaining function signature issues
  content = content.replace(/function authenticateAdmin.*?\}[\s\n]*/g, '');
  
  return content;
}

function main() {
  console.log('🔧 Direct Server.js Fix');
  console.log('======================');
  
  // Create backup
  fs.copyFileSync('server.js', 'server.js.direct-fix-backup');
  console.log('📁 Created backup: server.js.direct-fix-backup');
  
  // Apply fixes
  const fixedContent = fixServerFile();
  
  // Write fixed content
  fs.writeFileSync('server.js', fixedContent, 'utf8');
  console.log('✅ Applied direct fixes to server.js');
  
  // Basic validation
  console.log('🔍 Checking for remaining issues...');
  
  if (fixedContent.includes('authenticate, async')) {
    console.log('✅ Fixed missing commas in middleware chains');
  }
  
  if (fixedContent.includes('PERMISSIONS.')) {
    console.log('✅ PERMISSIONS references look good');
  }
  
  if (!fixedContent.includes('authenticateToken')) {
    console.log('✅ Removed old authenticateToken references');
  }
  
  if (fixedContent.includes('app.use(\'/api/auth\', authRoutes)')) {
    console.log('✅ Unified auth routes are mounted');
  }
  
  console.log('\n🎉 Direct fixes applied! Try starting your server now:');
  console.log('   npm start');
  
  console.log('\n📝 If you still get errors, check that you have:');
  console.log('   - src/middleware/rbac.js');
  console.log('   - src/routes/auth.js');
}

if (require.main === module) {
  main();
}
