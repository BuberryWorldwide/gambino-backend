const CredentialManager = require('../src/services/credentialManager');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CredentialMigration {
  constructor() {
    this.credentialManager = new CredentialManager();
    // Fix: Look for keys in project root, not script directory
    this.keysDir = path.join(process.cwd(), '..', '..', 'keys');
    this.migrationLog = [];
  }

  async migrateAllCredentials() {
    console.log(`
🔐 ============================================
   GAMBINO CREDENTIAL MIGRATION
   Converting plain-text keys to secure vault
🔐 ============================================
`);

    try {
      console.log(`📁 Looking for keys in: ${this.keysDir}`);
      
      if (!fs.existsSync(this.keysDir)) {
        console.log(`❌ Keys directory not found: ${this.keysDir}`);
        console.log('ℹ️  Let me check alternative locations...');
        
        // Try alternative paths
        const alternativePaths = [
          path.join(process.cwd(), '..', 'keys'),
          path.join(process.cwd(), 'keys'),
          '/opt/gambino/keys'
        ];
        
        for (const altPath of alternativePaths) {
          if (fs.existsSync(altPath)) {
            console.log(`✅ Found keys at: ${altPath}`);
            this.keysDir = altPath;
            break;
          }
        }
        
        if (!fs.existsSync(this.keysDir)) {
          console.log('❌ No keys directory found in any location');
          return;
        }
      }

      const files = fs.readdirSync(this.keysDir);
      console.log(`📋 Found ${files.length} files in keys directory:`);
      files.forEach(file => console.log(`   - ${file}`));

      if (files.length === 0) {
        console.log('\\n⚠️  No files found to migrate');
        return;
      }

      await this.discoverAndMigrateKeys();
      await this.generateReport();
      
      console.log('\\n🎉 Migration process completed!');
      
    } catch (error) {
      console.error('💥 Migration failed:', error);
      throw error;
    }
  }

  async discoverAndMigrateKeys() {
    const keyFiles = [
      { pattern: 'jackpotReserve-wallet.json', accountType: 'jackpotReserve' },
      { pattern: 'operationsReserve-wallet.json', accountType: 'operationsReserve' },
      { pattern: 'teamReserve-wallet.json', accountType: 'teamReserve' },
      { pattern: 'communityRewards-wallet.json', accountType: 'communityRewards' },
      { pattern: 'marketing-wallet.json', accountType: 'marketing' },
      { pattern: 'testing-wallet.json', accountType: 'testing' },
      { pattern: 'treasury.json', accountType: 'mainTreasury' },
      { pattern: 'payer.json', accountType: 'payer' }
    ];

    let migratedCount = 0;

    for (const keyFile of keyFiles) {
      const filePath = path.join(this.keysDir, keyFile.pattern);
      
      if (fs.existsSync(filePath)) {
        console.log(`\\n🔑 Found: ${keyFile.pattern}`);
        
        try {
          const keyData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const normalizedData = this.normalizeCredentialFormat(keyData, keyFile.accountType);
          
          const result = await this.credentialManager.storeCredentials(keyFile.accountType, normalizedData);
          
          if (result.success) {
            migratedCount++;
            console.log(`✅ Migrated: ${keyFile.accountType}`);
            console.log(`🔒 Security level: ${result.securityLevel}`);
            
            // Backup original
            const backupPath = filePath + '.backup';
            fs.copyFileSync(filePath, backupPath);
            console.log(`📁 Backed up to: ${backupPath}`);
          } else {
            console.log(`❌ Failed: ${result.error}`);
          }
          
          this.migrationLog.push({
            accountType: keyFile.accountType,
            originalFile: keyFile.pattern,
            result: result.success ? 'SUCCESS' : 'FAILED',
            error: result.error || null,
            timestamp: new Date().toISOString()
          });
          
        } catch (error) {
          console.log(`❌ Error processing ${keyFile.pattern}: ${error.message}`);
        }
      }
    }

    console.log(`\\n📊 Migration Summary: ${migratedCount} credentials migrated`);
  }

  normalizeCredentialFormat(keyData, accountType) {
    let normalizedData = {};

    if (Array.isArray(keyData)) {
      // Plain secret key array
      normalizedData = {
        label: `🔐 ${accountType.toUpperCase()}`,
        secretKey: keyData,
        accountType: accountType
      };
    } else if (keyData.secretKey || keyData.privateKey) {
      // Object format
      normalizedData = {
        label: keyData.label || `🔐 ${accountType.toUpperCase()}`,
        description: keyData.description || `Treasury account for ${accountType}`,
        secretKey: keyData.secretKey || keyData.privateKey,
        publicKey: keyData.publicKey,
        tokenAccount: keyData.tokenAccount,
        percentage: keyData.percentage,
        purpose: keyData.purpose || accountType,
        accountType: accountType,
        ...keyData
      };
    } else {
      throw new Error(`Unknown credential format for ${accountType}`);
    }

    if (!normalizedData.secretKey) {
      throw new Error(`No secret key found for ${accountType}`);
    }

    normalizedData.migratedAt = new Date().toISOString();
    return normalizedData;
  }

  async generateReport() {
    const reportPath = path.join(process.cwd(), '..', '..', 'CREDENTIAL-MIGRATION-REPORT.json');
    const report = {
      migrationCompleted: new Date().toISOString(),
      keysDirectory: this.keysDir,
      vaultLocation: this.credentialManager.vaultPath,
      migratedAccounts: this.migrationLog.length,
      successfulMigrations: this.migrationLog.filter(m => m.result === 'SUCCESS').length,
      failedMigrations: this.migrationLog.filter(m => m.result === 'FAILED').length,
      migrationLog: this.migrationLog,
      instructions: [
        'Your credentials are now securely encrypted',
        'The secure-vault directory contains encrypted credential files',
        'Original files have been backed up with .backup extension',
        'Use CredentialManager class to access credentials in your code',
        'Add TREASURY_MASTER_KEY to your .env file for persistence'
      ]
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Migration report saved: ${reportPath}`);
  }

  async testCredentialAccess() {
    console.log('\\n🧪 Testing credential access...\\n');
    
    const credentialsList = await this.credentialManager.listCredentials();
    
    if (!credentialsList.success) {
      console.log('❌ Failed to list credentials');
      return;
    }

    if (credentialsList.credentials.length === 0) {
      console.log('ℹ️  No credentials found in vault');
      return;
    }

    for (const credInfo of credentialsList.credentials) {
      console.log(`Testing ${credInfo.accountType}...`);
      
      const result = await this.credentialManager.getKeypair(credInfo.accountType, 'MIGRATION_TEST');
      
      if (result.success) {
        console.log(`✅ ${credInfo.accountType}: Successfully retrieved keypair`);
        console.log(`   Public Key: ${result.keypair.publicKey.toString()}`);
        console.log(`   Security: ${result.securityLevel}`);
      } else {
        console.log(`❌ ${credInfo.accountType}: ${result.error}`);
      }
      
      console.log('');
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const migration = new CredentialMigration();
  
  if (args.includes('--test-only')) {
    migration.testCredentialAccess();
  } else {
    migration.migrateAllCredentials()
      .then(() => {
        if (args.includes('--test')) {
          return migration.testCredentialAccess();
        }
      })
      .catch(error => {
        console.error('💥 Migration failed:', error);
        process.exit(1);
      });
  }
}

module.exports = CredentialMigration;
