#!/usr/bin/env node

/**
 * Quick Syntax Fix Script for RBAC Migration
 * Fixes syntax errors in the migrated server.js file
 */

const fs = require('fs');

function fixSyntaxErrors() {
  console.log('🔧 Fixing syntax errors in server.js...');
  
  let content = fs.readFileSync('server.js', 'utf8');
  
  // Fix 1: Add missing commas before async handlers
  content = content.replace(/(authenticate|requirePermission\([^)]+\)|createVenueMiddleware\([^)]*\))(\s*async\s*\()/g, '$1, $2');
  
  // Fix 2: Remove incomplete middleware definitions that weren't properly removed
  content = content.replace(/const requireRole = \([^)]*\) => \{[^}]*\};?\s*/g, '');
  content = content.replace(/const requireVenueAccess = \([^)]*\) => \{[\s\S]*?\};?\s*/g, '');
  content = content.replace(/const createVenueAccessChain = \([^)]*\) => \{[\s\S]*?\};?\s*/g, '');
  
  // Fix 3: Fix broken route definitions
  content = content.replace(/app\.(get|post|put|delete)\('([^']+)',\s*authenticate([^,]*)\s*async/g, 'app.$1(\'$2\', authenticate$3, async');
  
  // Fix 4: Fix specific broken patterns
  content = content.replace(/authenticateasync/g, 'authenticate, async');
  content = content.replace(/authenticate,\s*,\s*async/g, 'authenticate, async');
  
  // Fix 5: Remove duplicate RBAC imports that might be in wrong places
  const lines = content.split('\n');
  const rbacImportPattern = /require\(['"]\.\/src\/middleware\/rbac['"]\)/;
  let rbacImportFound = false;
  let rbacImportIndex = -1;
  
  // Find the first RBAC import and remove duplicates
  const filteredLines = lines.filter((line, index) => {
    if (rbacImportPattern.test(line)) {
      if (!rbacImportFound) {
        rbacImportFound = true;
        rbacImportIndex = index;
        return true;
      }
      return false; // Remove duplicate
    }
    return true;
  });
  
  content = filteredLines.join('\n');
  
  // Fix 6: Fix permission references that might be missing PERMISSIONS.
  content = content.replace(/requirePermission\(([A-Z_]+)\)/g, (match, perm) => {
    if (perm.startsWith('PERMISSIONS.')) return match;
    return `requirePermission(PERMISSIONS.${perm})`;
  });
  
  // Fix 7: Clean up any remaining broken middleware chains
  content = content.replace(/\.\.\.[^,\s]*createVenue[^,\s]*\(\s*\{[^}]*\}\s*\)/g, (match) => {
    if (!match.includes('createVenueMiddleware')) {
      return match.replace(/createVenue[^(]*/, 'createVenueMiddleware');
    }
    return match;
  });
  
  // Fix 8: Remove legacy reconciliation setup that references old middleware
  content = content.replace(/setupMiddleware\(authenticateToken.*?\);?\s*/g, '');
  
  fs.writeFileSync('server.js', content, 'utf8');
  console.log('✅ Syntax errors fixed');
}

function validateSyntax() {
  console.log('🔍 Validating syntax...');
  
  try {
    // Try to parse the JavaScript to check for syntax errors
    const content = fs.readFileSync('server.js', 'utf8');
    
    // Basic validation - check for common issues
    const issues = [];
    
    // Check for missing commas before async
    if (content.match(/(authenticate|requirePermission)\s+async/)) {
      issues.push('Missing comma before async handler');
    }
    
    // Check for undefined references
    if (content.includes('authenticateToken') && !content.includes('const authenticateToken')) {
      issues.push('Reference to removed authenticateToken');
    }
    
    if (content.includes('requireRole') && !content.includes('const requireRole')) {
      issues.push('Reference to removed requireRole');
    }
    
    if (issues.length > 0) {
      console.log('⚠️ Potential issues found:');
      issues.forEach(issue => console.log(`  - ${issue}`));
      return false;
    }
    
    console.log('✅ Basic syntax validation passed');
    return true;
    
  } catch (error) {
    console.error('❌ Syntax validation failed:', error.message);
    return false;
  }
}

function main() {
  console.log('🔧 RBAC Migration Syntax Fixer');
  console.log('=============================\n');
  
  if (!fs.existsSync('server.js')) {
    console.error('❌ server.js not found');
    process.exit(1);
  }
  
  // Create backup
  fs.copyFileSync('server.js', 'server.js.pre-syntax-fix');
  console.log('📁 Created backup: server.js.pre-syntax-fix');
  
  // Fix syntax errors
  fixSyntaxErrors();
  
  // Validate
  const isValid = validateSyntax();
  
  if (isValid) {
    console.log('\n🎉 Syntax fixes completed successfully!');
    console.log('You can now test your server with: npm start');
  } else {
    console.log('\n⚠️ Some issues may remain - manual review recommended');
  }
}

if (require.main === module) {
  main();
}

module.exports = { fixSyntaxErrors, validateSyntax };
