#!/usr/bin/env node

/**
 * RBAC Migration Script for Gambino Admin System
 * Automatically migrates existing routes to use new RBAC system
 * 
 * Usage: node migrate-to-rbac.js [--backup] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const CONFIG = {
  serverFile: 'server.js',
  backupFile: 'server.js.pre-rbac-backup',
  dryRun: process.argv.includes('--dry-run'),
  createBackup: process.argv.includes('--backup') || true, // Default to creating backup
  logLevel: 'info' // 'debug', 'info', 'warn', 'error'
};

// Migration mappings
const MIDDLEWARE_MAPPINGS = {
  'authenticateToken': 'authenticate',
  'authenticateAdmin': 'authenticate',
  'requireRole': 'requirePermission',
  'requireVenueAccess': 'requireVenueAccess',
  'createVenueAccessChain': 'createVenueMiddleware'
};

// Role to permission mappings
const ROLE_TO_PERMISSIONS = {
  "['super_admin', 'gambino_ops']": 'PERMISSIONS.VIEW_ALL_METRICS',
  "['super_admin']": 'PERMISSIONS.SYSTEM_ADMIN',
  "['venue_manager', 'gambino_ops', 'super_admin']": 'PERMISSIONS.MANAGE_ASSIGNED_STORES',
  "['venue_manager']": 'PERMISSIONS.MANAGE_ASSIGNED_STORES',
  "['venue_staff', 'venue_manager']": 'PERMISSIONS.VIEW_ASSIGNED_STORES'
};

// Utility functions
function log(level, message, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const configLevel = levels[CONFIG.logLevel] || 1;
  
  if (levels[level] >= configLevel) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    console.log(prefix, message, ...args);
  }
}

function createBackup(sourceFile, backupFile) {
  try {
    fs.copyFileSync(sourceFile, backupFile);
    log('info', `✅ Backup created: ${backupFile}`);
    return true;
  } catch (error) {
    log('error', `❌ Failed to create backup:`, error.message);
    return false;
  }
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    log('error', `❌ Failed to read file ${filePath}:`, error.message);
    throw error;
  }
}

function writeFile(filePath, content) {
  if (CONFIG.dryRun) {
    log('info', `🔍 DRY RUN: Would write ${content.length} characters to ${filePath}`);
    return;
  }
  
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    log('info', `✅ Written to ${filePath}`);
  } catch (error) {
    log('error', `❌ Failed to write file ${filePath}:`, error.message);
    throw error;
  }
}

class RBACMigrator {
  constructor(sourceCode) {
    this.sourceCode = sourceCode;
    this.migrations = [];
    this.errors = [];
    this.warnings = [];
  }

  // Add import statements for new RBAC system
  addRBACImports() {
    log('info', '📦 Adding RBAC imports...');
    
    const rbacImport = `
// RBAC System - Added by migration script
const { 
  authenticate, 
  requirePermission, 
  requireVenueAccess,
  createVenueMiddleware,
  PERMISSIONS 
} = require('./src/middleware/rbac');
`;

    // Find existing require statements and add after them
    const requireRegex = /^const.*require.*$/gm;
    const matches = [...this.sourceCode.matchAll(requireRegex)];
    
    if (matches.length > 0) {
      const lastRequire = matches[matches.length - 1];
      const insertPos = lastRequire.index + lastRequire[0].length;
      
      this.sourceCode = 
        this.sourceCode.slice(0, insertPos) + 
        rbacImport + 
        this.sourceCode.slice(insertPos);
      
      this.migrations.push('Added RBAC imports');
      log('debug', 'RBAC imports added after existing requires');
    } else {
      // Add at the beginning if no requires found
      this.sourceCode = rbacImport + '\n' + this.sourceCode;
      this.migrations.push('Added RBAC imports at beginning');
      log('debug', 'RBAC imports added at file beginning');
    }
  }

  // Remove old middleware definitions
  removeOldMiddleware() {
    log('info', '🗑️ Removing old middleware definitions...');
    
    const middlewarePatterns = [
      // authenticateToken function
      /const authenticateToken = \(req, res, next\) => \{[\s\S]*?\};/g,
      // authenticateAdmin function  
      /function authenticateAdmin\(req, res, next\) \{[\s\S]*?\}/g,
      // requireRole function
      /const requireRole = \([^)]*\) => \{[\s\S]*?\};/g,
      // requireVenueAccess function (old version)
      /const requireVenueAccess = \([^)]*\) => \{[\s\S]*?\};/g,
      // createVenueAccessChain function (old version)
      /const createVenueAccessChain = \([^)]*\) => \{[\s\S]*?\};/g,
      // validateStore function
      /const validateStore = async \([^)]*\) => \{[\s\S]*?\};/g,
      // auditVenueAccess function
      /const auditVenueAccess = \([^)]*\) => \{[\s\S]*?\};/g
    ];

    let removedCount = 0;
    middlewarePatterns.forEach((pattern, index) => {
      const matches = this.sourceCode.match(pattern);
      if (matches) {
        this.sourceCode = this.sourceCode.replace(pattern, '');
        removedCount++;
        log('debug', `Removed middleware pattern ${index + 1}`);
      }
    });

    this.migrations.push(`Removed ${removedCount} old middleware definitions`);
  }

  // Replace old login endpoints with unified auth route
  replaceLoginEndpoints() {
    log('info', '🔄 Replacing login endpoints...');
    
    // Remove old login endpoints
    const oldLoginPatterns = [
      // /api/users/login endpoint
      /app\.post\('\/api\/users\/login'[^}]*\}[\s\S]*?\}\);/g,
      // /api/admin/login endpoint  
      /app\.post\('\/api\/admin\/login'[^}]*\}[\s\S]*?\}\);/g
    ];

    let removedEndpoints = 0;
    oldLoginPatterns.forEach(pattern => {
      const matches = this.sourceCode.match(pattern);
      if (matches) {
        this.sourceCode = this.sourceCode.replace(pattern, '');
        removedEndpoints++;
      }
    });

    // Add unified auth routes
    const authRouteMount = `
// Unified Authentication Routes - Added by migration script
const authRoutes = require('./src/routes/auth');
app.use('/api/auth', authRoutes);
`;

    // Find where to insert (after other app.use statements)
    const appUseRegex = /app\.use\([^)]*\);/g;
    const appUseMatches = [...this.sourceCode.matchAll(appUseRegex)];
    
    if (appUseMatches.length > 0) {
      const lastAppUse = appUseMatches[appUseMatches.length - 1];
      const insertPos = lastAppUse.index + lastAppUse[0].length;
      
      this.sourceCode = 
        this.sourceCode.slice(0, insertPos) + 
        authRouteMount + 
        this.sourceCode.slice(insertPos);
    } else {
      // Add after middleware definitions if no app.use found
      const middlewareEnd = this.sourceCode.indexOf('// ===== ROUTES =====');
      if (middlewareEnd > -1) {
        this.sourceCode = 
          this.sourceCode.slice(0, middlewareEnd) + 
          authRouteMount + '\n' +
          this.sourceCode.slice(middlewareEnd);
      }
    }

    this.migrations.push(`Replaced ${removedEndpoints} login endpoints with unified auth`);
  }

  // Convert route middleware to RBAC
  convertRouteMiddleware() {
    log('info', '🔧 Converting route middleware...');
    
    const routePatterns = [
      // Standard route patterns: app.get, app.post, app.put, app.delete
      {
        pattern: /app\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\s\S]*?)(?=async\s*\(|function|\(req,\s*res)/g,
        type: 'standard_route'
      }
    ];

    let convertedRoutes = 0;
    
    routePatterns.forEach(({ pattern, type }) => {
      this.sourceCode = this.sourceCode.replace(pattern, (match, method, route, middlewareChain) => {
        log('debug', `Converting ${method.toUpperCase()} ${route}`);
        
        const convertedMiddleware = this.convertMiddlewareChain(middlewareChain, route);
        convertedRoutes++;
        
        return `app.${method}('${route}', ${convertedMiddleware}`;
      });
    });

    this.migrations.push(`Converted ${convertedRoutes} routes to RBAC`);
  }

  // Convert individual middleware chains
  convertMiddlewareChain(middlewareChain, route) {
    log('debug', `Converting middleware for route: ${route}`);
    
    // Clean up the middleware chain
    let cleaned = middlewareChain
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/,$/, ''); // Remove trailing comma

    // Handle different middleware patterns
    
    // Simple string replacements
    const stringReplacements = {
      'authenticateToken': 'authenticate',
      'authenticateAdmin': 'authenticate'
    };
    
    // Apply string replacements
    Object.entries(stringReplacements).forEach(([pattern, replacement]) => {
      cleaned = cleaned.replace(new RegExp(pattern, 'g'), replacement);
    });
    
    // Handle regex replacements that need functions
    const regexReplacements = [
      {
        pattern: /requireRole\(\s*(\[[^\]]+\])\s*\)/g,
        replacement: (match, roles) => {
          const permission = this.roleArrayToPermission(roles, route);
          return `requirePermission(${permission})`;
        }
      },
      {
        pattern: /\.\.\.createVenueAccessChain\(\s*\{([^}]*)\}\s*\)/g,
        replacement: (match, options) => {
          return `...createVenueMiddleware({ ${options} })`;
        }
      },
      {
        pattern: /requireVenueAccess\(\s*\{([^}]*)\}\s*\)/g,
        replacement: (match, options) => {
          return `requireVenueAccess({ ${options} })`;
        }
      }
    ];
    
    // Apply regex replacements
    regexReplacements.forEach(({ pattern, replacement }) => {
      cleaned = cleaned.replace(pattern, replacement);
    });

    return cleaned;
  }

  // Convert role arrays to permissions
  roleArrayToPermission(roleArray, route) {
    const cleanRoles = roleArray.replace(/'/g, '"');
    
    // Check for specific permission patterns based on route
    if (route.includes('/metrics')) {
      if (cleanRoles.includes('super_admin') && cleanRoles.includes('gambino_ops')) {
        return 'PERMISSIONS.VIEW_ALL_METRICS';
      }
      return 'PERMISSIONS.VIEW_STORE_METRICS';
    }
    
    if (route.includes('/users')) {
      if (route.includes('PUT') || route.includes('POST')) {
        return 'PERMISSIONS.MANAGE_USERS';
      }
      return 'PERMISSIONS.VIEW_USERS';
    }
    
    if (route.includes('/stores')) {
      if (cleanRoles.includes('venue_manager')) {
        return 'PERMISSIONS.MANAGE_ASSIGNED_STORES';
      }
      if (cleanRoles.includes('super_admin')) {
        return 'PERMISSIONS.MANAGE_ALL_STORES';
      }
      return 'PERMISSIONS.VIEW_ALL_STORES';
    }
    
    if (route.includes('/wallet')) {
      return 'PERMISSIONS.MANAGE_STORE_WALLETS';
    }
    
    // Default mappings
    if (cleanRoles.includes('super_admin') && cleanRoles.includes('gambino_ops')) {
      return 'PERMISSIONS.VIEW_ALL_METRICS';
    }
    
    if (cleanRoles.includes('super_admin')) {
      return 'PERMISSIONS.SYSTEM_ADMIN';
    }
    
    // Fallback to role-based for complex cases
    this.warnings.push(`Could not determine permission for roles ${roleArray} in route ${route}, using role-based fallback`);
    return `[${roleArray}] /* TODO: Convert to permission-based */`;
  }

  // Update request object usage in handlers
  updateRequestObjectUsage() {
    log('info', '📝 Updating request object usage...');
    
    const replacements = [
      // req.admin -> req.user (for admin endpoints)
      {
        pattern: /req\.admin\.(role|userId|email)/g,
        replacement: 'req.user.$1'
      },
      
      // Add permission checking examples
      {
        pattern: /\/\/ Check role manually[\s\S]*?return res\.status\(403\)\.json\([^}]*\);/g,
        replacement: '// Permission checking now handled by middleware'
      }
    ];

    let replacements_made = 0;
    replacements.forEach(({ pattern, replacement }) => {
      const matches = this.sourceCode.match(pattern);
      if (matches) {
        this.sourceCode = this.sourceCode.replace(pattern, replacement);
        replacements_made += matches.length;
      }
    });

    this.migrations.push(`Updated ${replacements_made} request object references`);
  }

  // Add helpful comments for manual review
  addMigrationComments() {
    log('info', '💬 Adding migration comments...');
    
    const headerComment = `/*
 * RBAC MIGRATION COMPLETED - ${new Date().toISOString()}
 * 
 * This file has been automatically migrated to use the new RBAC system.
 * 
 * CHANGES MADE:
${this.migrations.map(m => ` * - ${m}`).join('\n')}
 *
 * WARNINGS:
${this.warnings.length ? this.warnings.map(w => ` * ! ${w}`).join('\n') : ' * None'}
 *
 * TODO - Manual Review Required:
 * 1. Test all endpoints with different user roles
 * 2. Verify permission mappings are correct
 * 3. Check venue access restrictions
 * 4. Update any custom middleware not covered by this script
 * 5. Remove this comment block after review
 */

`;

    this.sourceCode = headerComment + this.sourceCode;
  }

  // Main migration method
  migrate() {
    log('info', '🚀 Starting RBAC migration...');
    
    try {
      this.addRBACImports();
      this.removeOldMiddleware(); 
      this.replaceLoginEndpoints();
      this.convertRouteMiddleware();
      this.updateRequestObjectUsage();
      this.addMigrationComments();
      
      log('info', `✅ Migration completed successfully!`);
      log('info', `📊 Summary: ${this.migrations.length} changes, ${this.warnings.length} warnings`);
      
      return {
        success: true,
        migrations: this.migrations,
        warnings: this.warnings,
        sourceCode: this.sourceCode
      };
      
    } catch (error) {
      log('error', '❌ Migration failed:', error.message);
      return {
        success: false,
        error: error.message,
        migrations: this.migrations,
        warnings: this.warnings
      };
    }
  }
}

// Validation functions
function validateEnvironment() {
  log('info', '🔍 Validating environment...');
  
  const required_files = [
    'src/middleware/rbac.js',
    'src/routes/auth.js'
  ];
  
  const missing_files = required_files.filter(file => !fs.existsSync(file));
  
  if (missing_files.length > 0) {
    log('error', '❌ Missing required RBAC files:');
    missing_files.forEach(file => log('error', `  - ${file}`));
    log('error', 'Please create these files first using the provided artifacts.');
    process.exit(1);
  }
  
  log('info', '✅ Environment validation passed');
}

function validateMigration(originalCode, migratedCode) {
  log('info', '🔍 Validating migration...');
  
  const checks = [
    {
      name: 'RBAC imports added',
      check: migratedCode.includes('require(\'./src/middleware/rbac\')'),
    },
    {
      name: 'Auth routes mounted',
      check: migratedCode.includes('app.use(\'/api/auth\', authRoutes)'),
    },
    {
      name: 'Old authenticateToken removed', 
      check: !migratedCode.includes('const authenticateToken ='),
    },
    {
      name: 'Old login endpoints removed',
      check: !migratedCode.includes('app.post(\'/api/users/login\'') && 
             !migratedCode.includes('app.post(\'/api/admin/login\''),
    },
    {
      name: 'File size reasonable',
      check: Math.abs(migratedCode.length - originalCode.length) < originalCode.length * 0.5,
    }
  ];
  
  const passed = checks.filter(c => c.check).length;
  const total = checks.length;
  
  log('info', `📊 Validation: ${passed}/${total} checks passed`);
  
  checks.forEach(({ name, check }) => {
    log(check ? 'info' : 'warn', `${check ? '✅' : '⚠️'} ${name}`);
  });
  
  if (passed < total * 0.8) {
    log('warn', '⚠️ Migration may have issues - manual review recommended');
    return false;
  }
  
  return true;
}

// Main execution
async function main() {
  console.log('🎯 RBAC Migration Script for Gambino Admin System\n');
  
  try {
    // Validate environment
    validateEnvironment();
    
    // Check if source file exists
    if (!fs.existsSync(CONFIG.serverFile)) {
      log('error', `❌ Source file not found: ${CONFIG.serverFile}`);
      process.exit(1);
    }
    
    // Create backup if requested
    if (CONFIG.createBackup) {
      if (!createBackup(CONFIG.serverFile, CONFIG.backupFile)) {
        log('error', '❌ Failed to create backup - aborting migration');
        process.exit(1);
      }
    }
    
    // Read source code
    log('info', `📖 Reading source file: ${CONFIG.serverFile}`);
    const originalCode = readFile(CONFIG.serverFile);
    
    // Run migration
    const migrator = new RBACMigrator(originalCode);
    const result = migrator.migrate();
    
    if (!result.success) {
      log('error', '❌ Migration failed:', result.error);
      process.exit(1);
    }
    
    // Validate migration
    const isValid = validateMigration(originalCode, result.sourceCode);
    
    // Write migrated code
    if (!CONFIG.dryRun) {
      writeFile(CONFIG.serverFile, result.sourceCode);
      log('info', `✅ Migration written to ${CONFIG.serverFile}`);
    }
    
    // Summary
    console.log('\n📋 Migration Summary:');
    console.log(`   Changes: ${result.migrations.length}`);
    console.log(`   Warnings: ${result.warnings.length}`);
    console.log(`   Validation: ${isValid ? 'PASSED' : 'NEEDS REVIEW'}`);
    
    if (result.warnings.length > 0) {
      console.log('\n⚠️ Warnings:');
      result.warnings.forEach(warning => console.log(`   - ${warning}`));
    }
    
    console.log('\n🎉 Next Steps:');
    console.log('   1. Review the migrated code for accuracy');
    console.log('   2. Test all endpoints with different user roles');
    console.log('   3. Run your test suite to ensure nothing is broken');
    console.log('   4. Remove backup file once satisfied');
    
    if (!isValid) {
      console.log('\n⚠️ IMPORTANT: Migration validation failed - manual review required!');
    }
    
  } catch (error) {
    log('error', '💥 Fatal error:', error.message);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { RBACMigrator, validateEnvironment, validateMigration };
