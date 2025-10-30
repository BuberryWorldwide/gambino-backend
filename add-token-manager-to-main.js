const fs = require('fs');

const mainPath = './src/main.js';
let content = fs.readFileSync(mainPath, 'utf8');

// Add TokenManager import after other requires
if (!content.includes('TokenManager')) {
  content = content.replace(
    /(const logger = require\('\.\/utils\/logger'\);)/,
    "$1\nconst TokenManager = require('./utils/tokenManager');"
  );
  
  // Add tokenManager property to constructor
  content = content.replace(
    /(this\.healthMonitor = new HealthMonitor\(this\.config, this\.apiClient\);)/,
    "$1\n    this.tokenManager = null; // Will be initialized in start()"
  );
  
  // Add tokenManager initialization in start() method, after config.load()
  content = content.replace(
    /(await this\.config\.load\(\);\s+logger\.info[^;]+;)/,
    `$1
    
    // Initialize token manager for auto-refresh
    this.tokenManager = new TokenManager(this.config.get('apiBaseUrl'));
    await this.tokenManager.init();
    this.apiClient.setTokenManager(this.tokenManager);
    logger.info('🔑 Token auto-refresh enabled');`
  );
  
  fs.writeFileSync(mainPath, content);
  console.log('✅ TokenManager added to main.js');
} else {
  console.log('ℹ️  TokenManager already in main.js');
}
