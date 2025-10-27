// Remove the example code from gambinoTokenService.js
const fs = require('fs');

console.log('🧹 CLEANING GAMBINO TOKEN SERVICE');
console.log('==================================');

let serviceCode = fs.readFileSync('src/services/gambinoTokenService.js', 'utf8');

// Find where the actual service ends (at module.exports)
const moduleExportIndex = serviceCode.indexOf('module.exports = GambinoTokenService;');

if (moduleExportIndex !== -1) {
  // Keep only the service code up to and including module.exports
  const cleanServiceCode = serviceCode.substring(0, moduleExportIndex + 'module.exports = GambinoTokenService;'.length);
  
  // Backup original
  fs.writeFileSync('src/services/gambinoTokenService.js.backup-messy', serviceCode);
  
  // Write clean version
  fs.writeFileSync('src/services/gambinoTokenService.js', cleanServiceCode);
  
  console.log('✅ Cleaned gambinoTokenService.js');
  console.log('✅ Removed example code that was causing duplicates');
  console.log('🔄 Server should start now');
} else {
  console.log('❌ Could not find module.exports line');
}
