// backend/src/services/secureTreasuryService.js
const { 
  Connection, 
  PublicKey,
  clusterApiUrl 
} = require('@solana/web3.js');
const { 
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAccount,
  burn,
  mintTo
} = require('@solana/spl-token');
const CredentialManager = require('./credentialManager');

class SecureTreasuryService {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'),
      'confirmed'
    );
    
    this.gambinoMint = new PublicKey(process.env.GAMBINO_MINT_ADDRESS);
    this.credentialManager = new CredentialManager();
    
    // Treasury account roles and permissions
    this.accountRoles = {
      jackpotReserve: {
        permissions: ['release_jackpot'],
        requiresApproval: true,
        maxDailyTransfer: 100000, // 100k GAMBINO
        description: 'Jackpot mining pool - only for gameplay rewards'
      },
      operationsReserve: {
        permissions: ['transfer', 'burn', 'operations'],
        requiresApproval: false,
        maxDailyTransfer: 500000, // 500k GAMBINO
        description: 'Operations treasury - business expenses'
      },
      teamReserve: {
        permissions: ['transfer'],
        requiresApproval: true,
        maxDailyTransfer: 200000, // 200k GAMBINO
        description: 'Team compensation treasury'
      },
      communityRewards: {
        permissions: ['transfer', 'airdrop'],
        requiresApproval: false,
        maxDailyTransfer: 150000, // 150k GAMBINO
        description: 'Community events and rewards'
      },
      marketing: {
        permissions: ['transfer', 'burn'],
        requiresApproval: false,
        maxDailyTransfer: 100000, // 100k GAMBINO
        description: 'Marketing and growth treasury'
      },
      testing: {
        permissions: ['transfer', 'burn', 'mint'],
        requiresApproval: false,
        maxDailyTransfer: 50000, // 50k GAMBINO
        description: 'Development and testing treasury'
      }
    };

    // Daily transfer tracking
    this.dailyTransfers = new Map();
    
    // Initialize security checks
    this.initializeSecurity();
  }

  async initializeSecurity() {
    // Check if vault is locked
    if (this.credentialManager.isLocked()) {
      console.log('🚨 Treasury vault is in emergency lockdown');
      throw new Error('Treasury operations suspended - vault locked');
    }

    // Verify vault integrity on startup
    const integrity = await this.credentialManager.verifyVaultIntegrity();
    if (!integrity.success || integrity.integrityScore < 100) {
      console.warn('⚠️  Treasury vault integrity issues detected');
    }
  }

  // Secure credential retrieval with audit logging
  async getSecureKeypair(accountType, operation, reason = '') {
    try {
      // Check if operation is permitted for this account
      if (!this.isOperationPermitted(accountType, operation)) {
        throw new Error(`Operation '${operation}' not permitted for ${accountType}`);
      }

      // Check daily transfer limits
      if (operation === 'transfer' && !this.checkDailyLimit(accountType)) {
        throw new Error(`Daily transfer limit exceeded for ${accountType}`);
      }

      // Retrieve credentials securely
      const result = await this.credentialManager.getKeypair(
        accountType, 
        `${operation.toUpperCase()}: ${reason}`
      );

      if (!result.success) {
        throw new Error(`Failed to retrieve credentials: ${result.error}`);
      }

      return result;
      
    } catch (error) {
      console.error(`❌ Secure keypair retrieval failed for ${accountType}:`, error);
      throw error;
    }
  }

  // Check if operation is permitted for account type
  isOperationPermitted(accountType, operation) {
    const role = this.accountRoles[accountType];
    if (!role) {
      return false;
    }
    
    return role.permissions.includes(operation);
  }

  // Check daily transfer limits
  checkDailyLimit(accountType, amount = 0) {
    const today = new Date().toDateString();
    const key = `${accountType}-${today}`;
    const currentTotal = this.dailyTransfers.get(key) || 0;
    const limit = this.accountRoles[accountType]?.maxDailyTransfer || 0;
    
    return (currentTotal + amount) <= limit;
  }

  // Update daily transfer tracking
  updateDailyTransfer(accountType, amount) {
    const today = new Date().toDateString();
    const key = `${accountType}-${today}`;
    const currentTotal = this.dailyTransfers.get(key) || 0;
    this.dailyTransfers.set(key, currentTotal + amount);
  }

  // Get treasury account balance with security checks
  async getSecureTreasuryBalance(accountType) {
    try {
      const credResult = await this.credentialManager.retrieveCredentials(
        accountType, 
        'BALANCE_CHECK'
      );

      if (!credResult.success) {
        throw new Error(`Failed to retrieve credentials: ${credResult.error}`);
      }

      const publicKey = new PublicKey(credResult.credentials.publicKey);
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        await this.getPayerKeypair(), // Use secure payer
        this.gambinoMint,
        publicKey
      );

      const balance = await getAccount(this.connection, tokenAccount.address);
      
      return {
        success: true,
        accountType,
        balance: Number(balance.amount) / Math.pow(10, 6),
        balanceRaw: Number(balance.amount),
        tokenAccount: tokenAccount.address.toString(),
        walletAddress: publicKey.toString(),
        securityLevel: credResult.securityLevel,
        metadata: credResult.metadata
      };
      
    } catch (error) {
      console.error(`❌ Error getting secure balance for ${accountType}:`, error);
      return { 
        success: false, 
        error: error.message,
        accountType 
      };
    }
  }

  // Secure transfer with multi-level approval
  async secureTransferFromTreasury(fromAccountType, toPublicKey, amount, reason, approvalCode = null) {
    try {
      // Validate inputs
      if (!fromAccountType || !toPublicKey || !amount || !reason) {
        throw new Error('Missing required parameters for treasury transfer');
      }

      if (amount <= 0) {
        throw new Error('Transfer amount must be positive');
      }

      // Check if approval is required
      const role = this.accountRoles[fromAccountType];
      if (role?.requiresApproval && !approvalCode) {
        throw new Error(`Transfer from ${fromAccountType} requires approval code`);
      }

      // Verify approval code if provided
      if (approvalCode && !this.verifyApprovalCode(fromAccountType, approvalCode)) {
        throw new Error('Invalid approval code');
      }

      // Check daily limits
      if (!this.checkDailyLimit(fromAccountType, amount)) {
        throw new Error(`Transfer would exceed daily limit for ${fromAccountType}`);
      }

      // Get secure keypair
      const keyResult = await this.getSecureKeypair(
        fromAccountType, 
        'transfer', 
        `Transfer ${amount} GAMBINO to ${toPublicKey} - ${reason}`
      );

      const fromKeypair = keyResult.keypair;
      const amountRaw = amount * Math.pow(10, 6);

      // Get token accounts
      const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        fromKeypair,
        this.gambinoMint,
        fromKeypair.publicKey
      );

      const toTokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        fromKeypair, // Payer
        this.gambinoMint,
        new PublicKey(toPublicKey)
      );

      // Execute transfer
      const signature = await transfer(
        this.connection,
        fromKeypair,
        fromTokenAccount.address,
        toTokenAccount.address,
        fromKeypair.publicKey,
        amountRaw
      );

      // Update daily transfer tracking
      this.updateDailyTransfer(fromAccountType, amount);

      // Log transaction for audit
      this.logSecureTransaction({
        type: 'secure_transfer',
        fromAccount: fromAccountType,
        toAddress: toPublicKey,
        amount: amount,
        reason: reason,
        signature: signature,
        approvalCode: approvalCode ? 'PROVIDED' : 'NOT_REQUIRED',
        securityLevel: keyResult.securityLevel,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        signature,
        amount,
        fromAccount: fromAccountType,
        toAddress: toPublicKey,
        reason,
        securityLevel: keyResult.securityLevel
      };
      
    } catch (error) {
      console.error('❌ Secure treasury transfer error:', error);
      
      // Log failed attempt
      this.logSecureTransaction({
        type: 'secure_transfer_failed',
        fromAccount: fromAccountType,
        toAddress: toPublicKey,
        amount: amount,
        reason: reason,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Secure jackpot release (special function for jackpot reserve)
  async secureReleaseJackpot(userPublicKey, amount, jackpotType, machineId, gameSession) {
    try {
      // Validate jackpot parameters
      if (!['minor', 'major', 'mega'].includes(jackpotType)) {
        throw new Error('Invalid jackpot type');
      }

      // Verify game session if provided
      if (gameSession && !this.verifyGameSession(gameSession)) {
        throw new Error('Invalid game session');
      }

      const reason = `${jackpotType} jackpot on ${machineId} - session: ${gameSession || 'N/A'}`;
      
      const result = await this.secureTransferFromTreasury(
        'jackpotReserve',
        userPublicKey,
        amount,
        reason
      );

      if (result.success) {
        // Update jackpot statistics
        this.updateJackpotStats(jackpotType, amount, machineId);
        
        // Log special jackpot event
        this.logSecureTransaction({
          type: 'jackpot_release',
          jackpotType,
          machineId,
          userPublicKey,
          amount,
          gameSession: gameSession || null,
          signature: result.signature,
          timestamp: new Date().toISOString()
        });
      }

      return result;
      
    } catch (error) {
      console.error('❌ Secure jackpot release error:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Secure token burning with audit trail
  async secureBurnTokens(fromAccountType, amount, reason, approvalCode = null) {
    try {
      // Check permissions
      if (!this.isOperationPermitted(fromAccountType, 'burn')) {
        throw new Error(`Burn operation not permitted for ${fromAccountType}`);
      }

      // Check approval requirements
      const role = this.accountRoles[fromAccountType];
      if (role?.requiresApproval && !approvalCode) {
        throw new Error(`Burn from ${fromAccountType} requires approval code`);
      }

      // Get secure keypair
      const keyResult = await this.getSecureKeypair(
        fromAccountType,
        'burn',
        `Burn ${amount} GAMBINO - ${reason}`
      );

      const accountKeypair = keyResult.keypair;
      const amountRaw = amount * Math.pow(10, 6);

      // Get token account
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        accountKeypair,
        this.gambinoMint,
        accountKeypair.publicKey
      );

      // Burn tokens
      const signature = await burn(
        this.connection,
        accountKeypair,
        tokenAccount.address,
        this.gambinoMint,
        accountKeypair.publicKey,
        amountRaw
      );

      // Log burn transaction
      this.logSecureTransaction({
        type: 'secure_burn',
        fromAccount: fromAccountType,
        amount: amount,
        reason: reason,
        signature: signature,
        approvalCode: approvalCode ? 'PROVIDED' : 'NOT_REQUIRED',
        securityLevel: keyResult.securityLevel,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        signature,
        burnedAmount: amount,
        fromAccount: fromAccountType,
        reason,
        securityLevel: keyResult.securityLevel
      };
      
    } catch (error) {
      console.error('❌ Secure burn error:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Get payer keypair securely
  async getPayerKeypair() {
    const result = await this.credentialManager.getKeypair('payer', 'TRANSACTION_FEE');
    if (!result.success) {
      throw new Error('Failed to get payer keypair');
    }
    return result.keypair;
  }

  // Verify approval codes (implement your approval system)
  verifyApprovalCode(accountType, approvalCode) {
    // Implement your approval verification logic
    // This could integrate with:
    // - Multi-signature wallets
    // - External approval systems
    // - Time-based codes
    // - Hardware security modules
    
    // For now, simple validation
    const expectedCode = this.generateApprovalCode(accountType);
    return approvalCode === expectedCode;
  }

  // Generate approval codes (implement your approval system)
  generateApprovalCode(accountType) {
    // This should be replaced with your actual approval system
    // Examples: TOTP, hardware token, multi-sig, etc.
    const baseCode = process.env.TREASURY_APPROVAL_SECRET || 'default';
    const crypto = require('crypto');
    const today = new Date().toDateString();
    
    return crypto
      .createHash('sha256')
      .update(`${baseCode}-${accountType}-${today}`)
      .digest('hex')
      .substring(0, 8)
      .toUpperCase();
  }

  // Verify game sessions (implement your game verification)
  verifyGameSession(gameSession) {
    // Implement game session verification
    // This should validate that the jackpot is legitimate
    return true; // Placeholder
  }

  // Update jackpot statistics
  updateJackpotStats(jackpotType, amount, machineId) {
    try {
      const fs = require('fs');
      const statsFile = './logs/secure-jackpot-stats.json';
      
      let stats = { 
        totalJackpots: 0, 
        totalAmount: 0, 
        byType: {}, 
        byMachine: {},
        securityEvents: []
      };
      
      if (fs.existsSync(statsFile)) {
        stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      }

      // Update totals
      stats.totalJackpots += 1;
      stats.totalAmount += amount;

      // Update by type
      if (!stats.byType[jackpotType]) {
        stats.byType[jackpotType] = { count: 0, amount: 0 };
      }
      stats.byType[jackpotType].count += 1;
      stats.byType[jackpotType].amount += amount;

      // Update by machine
      if (!stats.byMachine[machineId]) {
        stats.byMachine[machineId] = { count: 0, amount: 0 };
      }
      stats.byMachine[machineId].count += 1;
      stats.byMachine[machineId].amount += amount;

      // Add security event
      stats.securityEvents.push({
        type: 'jackpot_released',
        jackpotType,
        machineId,
        amount,
        timestamp: new Date().toISOString()
      });

      // Keep only last 1000 security events
      if (stats.securityEvents.length > 1000) {
        stats.securityEvents = stats.securityEvents.slice(-1000);
      }

      stats.lastUpdated = new Date().toISOString();
      
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
      
    } catch (error) {
      console.error('❌ Failed to update secure jackpot stats:', error);
    }
  }

  // Log secure transactions for audit
  logSecureTransaction(logEntry) {
    try {
      const fs = require('fs');
      const logFile = './logs/secure-treasury-transactions.json';
      
      // Create logs directory if it doesn't exist
      if (!fs.existsSync('./logs')) {
        fs.mkdirSync('./logs', { recursive: true });
      }

      let logs = [];
      if (fs.existsSync(logFile)) {
        logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      }

      // Add log entry with additional security metadata
      const secureLogEntry = {
        ...logEntry,
        logId: require('crypto').randomBytes(16).toString('hex'),
        pid: process.pid,
        user: process.env.USER || 'system',
        nodeVersion: process.version
      };

      logs.push(secureLogEntry);

      // Keep only last 10000 transactions
      if (logs.length > 10000) {
        logs = logs.slice(-10000);
      }

      fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
      console.log(`📝 Secure transaction logged: ${logEntry.type}`);
      
    } catch (error) {
      console.error('❌ Failed to log secure transaction:', error);
    }
  }

  // Get daily transfer summary
  getDailyTransferSummary() {
    const today = new Date().toDateString();
    const summary = {};
    
    for (const [accountType, role] of Object.entries(this.accountRoles)) {
      const key = `${accountType}-${today}`;
      const used = this.dailyTransfers.get(key) || 0;
      const limit = role.maxDailyTransfer;
      const remaining = limit - used;
      
      summary[accountType] = {
        used,
        limit,
        remaining,
        percentageUsed: ((used / limit) * 100).toFixed(1)
      };
    }
    
    return summary;
  }

  // Emergency lockdown
  async emergencyLockdown(reason) {
    console.log(`🚨 Initiating emergency treasury lockdown: ${reason}`);
    
    const result = await this.credentialManager.emergencyLockdown(reason);
    
    if (result.success) {
      this.logSecureTransaction({
        type: 'emergency_lockdown',
        reason,
        timestamp: new Date().toISOString(),
        initiatedBy: process.env.USER || 'system'
      });
    }
    
    return result;
  }

  // Health check for secure treasury
  async getSecurityHealthCheck() {
    try {
      const health = {
        vaultIntegrity: await this.credentialManager.verifyVaultIntegrity(),
        dailyLimits: this.getDailyTransferSummary(),
        isLocked: this.credentialManager.isLocked(),
        lastCheck: new Date().toISOString()
      };

      // Add security warnings
      const warnings = [];
      
      if (health.vaultIntegrity.integrityScore < 100) {
        warnings.push('Vault integrity issues detected');
      }
      
      if (health.isLocked) {
        warnings.push('Treasury is in emergency lockdown');
      }

      // Check for high daily usage
      for (const [account, usage] of Object.entries(health.dailyLimits)) {
        if (usage.percentageUsed > 80) {
          warnings.push(`${account} daily limit ${usage.percentageUsed}% used`);
        }
      }

      health.warnings = warnings;
      health.status = warnings.length === 0 ? 'HEALTHY' : 'ATTENTION_REQUIRED';

      return { success: true, health };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = SecureTreasuryService;
