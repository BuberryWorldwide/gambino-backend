#!/usr/bin/env node

/**
 * Complete RBAC Cleanup Script
 * Finds and fixes all remaining references to old middleware
 */

const fs = require('fs');

function findOldMiddlewareReferences() {
  console.log('🔍 Scanning for old middleware references...');
  
  const content = fs.readFileSync('server.js', 'utf8');
  const lines = content.split('\n');
  
  const oldMiddleware = [
    'authenticateToken',
    'authenticateAdmin', 
    'requireRole',
    'requireVenueAccess',
    'createVenueAccessChain'
  ];
  
  const references = [];
  
  lines.forEach((line, index) => {
    oldMiddleware.forEach(middleware => {
      // Skip if it's a definition (const authenticateToken = ...)
      if (line.includes(middleware) && !line.includes(`const ${middleware}`) && !line.includes(`function ${middleware}`)) {
        references.push({
          middleware,
          line: index + 1,
          content: line.trim()
        });
      }
    });
  });
  
  return references;
}

function fixAllMiddlewareReferences() {
  console.log('🔧 Fixing all middleware references...');
  
  let content = fs.readFileSync('server.js', 'utf8');
  
  // Comprehensive replacements
  const replacements = [
    // Fix reconciliation setup that still uses old middleware
    {
      pattern: /setupMiddleware\([^)]*authenticateToken[^)]*\);?/g,
      replacement: '// Reconciliation middleware setup removed - now handled by RBAC'
    },
    
    // Replace any remaining authenticateToken with authenticate
    {
      pattern: /\bauthenticateToken\b/g,
      replacement: 'authenticate'
    },
    
    // Replace any remaining authenticateAdmin with authenticate
    {
      pattern: /\bauthenticateAdmin\b/g,
      replacement: 'authenticate'
    },
    
    // Fix requireRole patterns - convert to requirePermission
    {
      pattern: /requireRole\(\s*\[([^\]]+)\]\s*\)/g,
      replacement: (match, roles) => {
        // Map common role patterns to permissions
        if (roles.includes('super_admin') && roles.includes('gambino_ops')) {
          return 'requirePermission(PERMISSIONS.VIEW_ALL_METRICS)';
        }
        if (roles.includes('super_admin')) {
          return 'requirePermission(PERMISSIONS.SYSTEM_ADMIN)';
        }
        if (roles.includes('venue_manager')) {
          return 'requirePermission(PERMISSIONS.MANAGE_ASSIGNED_STORES)';
        }
        // Fallback - use the first permission that makes sense
        return 'requirePermission(PERMISSIONS.VIEW_PROFILE)';
      }
    },
    
    // Fix createVenueAccessChain references
    {
      pattern: /createVenueAccessChain/g,
      replacement: 'createVenueMiddleware'
    },
    
    // Fix any remaining old venue access patterns
    {
      pattern: /\.\.\.createVenueMiddleware\(\s*\{([^}]*)\}\s*\)([^,\s])/g,
      replacement: '...createVenueMiddleware({ $1 }), $2'
    }
  ];
  
  let changesCount = 0;
  replacements.forEach(({ pattern, replacement }) => {
    const beforeLength = content.length;
    content = content.replace(pattern, replacement);
    if (content.length !== beforeLength) {
      changesCount++;
    }
  });
  
  // Ensure proper spacing and commas in middleware chains
  content = content.replace(/(authenticate|requirePermission\([^)]+\)|createVenueMiddleware\([^)]*\))\s+(async\s*\()/g, '$1, $2');
  
  fs.writeFileSync('server.js', content, 'utf8');
  console.log(`✅ Applied ${changesCount} middleware reference fixes`);
  
  return changesCount;
}

function addMissingPermissions() {
  console.log('🔧 Adding missing PERMISSIONS references...');
  
  let content = fs.readFileSync('server.js', 'utf8');
  
  // Find lines that use requirePermission but might be missing PERMISSIONS prefix
  const permissionPattern = /requirePermission\(([A-Z_]+)\)/g;
  let matches = content.match(permissionPattern);
  
  if (matches) {
    matches.forEach(match => {
      const permission = match.match(/requirePermission\(([A-Z_]+)\)/)[1];
      if (!permission.startsWith('PERMISSIONS.')) {
        content = content.replace(
          new RegExp(`requirePermission\\(${permission}\\)`, 'g'),
          `requirePermission(PERMISSIONS.${permission})`
        );
      }
    });
  }
  
  fs.writeFileSync('server.js', content, 'utf8');
  console.log('✅ Fixed PERMISSIONS references');
}

function validateAndReport() {
  console.log('📊 Final validation...');
  
  const content = fs.readFileSync('server.js', 'utf8');
  
  const checks = {
    hasRBACImports: content.includes("require('./src/middleware/rbac')"),
    hasAuthRoutes: content.includes("app.use('/api/auth', authRoutes)"),
    noOldAuthenticateToken: !content.match(/\bauthenticateToken\b/),
    noOldRequireRole: !content.match(/\brequireRole\(/),
    hasValidPermissions: content.includes('PERMISSIONS.'),
    syntaxLooksGood: !content.match(/(authenticate|requirePermission)\s+async/)
  };
  
  console.log('\n📋 Validation Results:');
  Object.entries(checks).forEach(([check, passed]) => {
    console.log(`  ${passed ? '✅' : '❌'} ${check}`);
  });
  
  const allPassed = Object.values(checks).every(v => v);
  
  if (allPassed) {
    console.log('\n🎉 All checks passed! Your server should now work.');
  } else {
    console.log('\n⚠️ Some issues remain. Check the failing items above.');
  }
  
  // Show remaining issues
  const references = findOldMiddlewareReferences();
  if (references.length > 0) {
    console.log('\n🔍 Remaining old middleware references:');
    references.forEach(ref => {
      console.log(`  Line ${ref.line}: ${ref.middleware} in "${ref.content}"`);
    });
  }
  
  return allPassed;
}

function main() {
  console.log('🧹 Complete RBAC Cleanup');
  console.log('========================\n');
  
  if (!fs.existsSync('server.js')) {
    console.error('❌ server.js not found');
    process.exit(1);
  }
  
  // Show initial scan
  const initialRefs = findOldMiddlewareReferences();
  console.log(`Found ${initialRefs.length} old middleware references to fix\n`);
  
  // Create another backup
  fs.copyFileSync('server.js', 'server.js.pre-cleanup');
  console.log('📁 Created backup: server.js.pre-cleanup');
  
  // Fix all issues
  const changes = fixAllMiddlewareReferences();
  addMissingPermissions();
  
  // Final validation
  const success = validateAndReport();
  
  if (success) {
    console.log('\n🚀 Cleanup completed! Try starting your server now:');
    console.log('   npm start');
  } else {
    console.log('\n🔧 Manual fixes may still be needed. Common remaining issues:');
    console.log('   1. Check that src/middleware/rbac.js exists');
    console.log('   2. Check that src/routes/auth.js exists'); 
    console.log('   3. Look for the specific line numbers mentioned above');
  }
}

if (require.main === module) {
  main();
}

module.exports = { findOldMiddlewareReferences, fixAllMiddlewareReferences, validateAndReport };
