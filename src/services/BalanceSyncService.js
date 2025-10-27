// src/services/BalanceSyncService.js

const { Connection, PublicKey } = require('@solana/web3.js');
const User = require('../models/User');

class BalanceSyncService {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC, "confirmed");
    this.isRunning = false;
    this.syncInterval = null;
    this.rateLimitDelay = 1000; // 1 second between requests
    this.batchSize = 10; // Process 10 wallets at a time
    
    this.TOKEN_MINTS = {
      GG: "Cd2wZyKVdWuyuJJHmeU1WmfSKNnDHku2m6mt6XFqGeXn",
      USDC: "Es9vMFrzaCERZ8YvKjWJ6dD3pDPnbuzcFh3RDFw4YcGJ"
    };
  }

  // Start the background sync service
  startService() {
    if (this.isRunning) return;
    
    console.log('🔄 Starting balance sync service...');
    this.isRunning = true;
    
    // Initial sync
    this.performBatchSync();
    
    // Set up recurring sync every 2 minutes
    this.syncInterval = setInterval(() => {
      this.performBatchSync();
    }, 2 * 60 * 1000); // 2 minutes
  }

  // Stop the service
  stopService() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isRunning = false;
    console.log('⏹️ Balance sync service stopped');
  }

  // Main batch sync function
  async performBatchSync() {
    if (!this.isRunning) return;

    try {
      // Get all users with wallets that need updating
      const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
      
      const usersToSync = await User.find({
        walletAddress: { $exists: true, $ne: null },
        $or: [
          { balanceLastUpdated: { $lt: staleThreshold } },
          { balanceLastUpdated: { $exists: false } }
        ],
        isActive: { $ne: false }
      })
      .select('_id walletAddress firstName')
      .limit(50) // Limit to prevent overwhelming
      .lean();

      if (usersToSync.length === 0) {
        console.log('✅ All balances up to date');
        return;
      }

      console.log(`🔄 Syncing balances for ${usersToSync.length} users...`);

      // Process in batches to avoid rate limits
      for (let i = 0; i < usersToSync.length; i += this.batchSize) {
        const batch = usersToSync.slice(i, i + this.batchSize);
        await this.processBatch(batch);
        
        // Rate limiting delay between batches
        if (i + this.batchSize < usersToSync.length) {
          await this.delay(this.rateLimitDelay);
        }
      }

      console.log(`✅ Batch sync completed for ${usersToSync.length} users`);

    } catch (error) {
      console.error('❌ Batch sync error:', error);
    }
  }

  // Process a batch of users
  async processBatch(users) {
    const promises = users.map(user => this.syncUserBalance(user));
    await Promise.allSettled(promises);
  }

  // Sync individual user balance
  async syncUserBalance(user) {
    try {
      const pubKey = new PublicKey(user.walletAddress);

      // Get SOL balance
      const solBalance = await this.connection.getBalance(pubKey);
      const solAmount = solBalance / 1e9;

      // Get token balances
      const tokenBalances = {};
      for (const [symbol, mint] of Object.entries(this.TOKEN_MINTS)) {
        try {
          const accounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
            mint: new PublicKey(mint)
          });

          tokenBalances[symbol] = accounts.value.length > 0 
            ? accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount 
            : 0;
        } catch (err) {
          tokenBalances[symbol] = 0;
        }
      }

      // Update database
      await User.findByIdAndUpdate(user._id, {
        cachedSolBalance: solAmount,
        cachedGambinoBalance: tokenBalances.GG || 0,
        cachedUsdcBalance: tokenBalances.USDC || 0,
        balanceLastUpdated: new Date(),
        balanceSyncError: null,
        balanceSyncAttempts: 0
      });

      console.log(`✅ Updated ${user.firstName || 'User'}: ${tokenBalances.GG || 0} GAMBINO`);

    } catch (error) {
      console.error(`❌ Failed to sync ${user.walletAddress.slice(0, 8)}...`, error.message);
      
      // Update error in database
      await User.findByIdAndUpdate(user._id, {
        balanceSyncError: error.message,
        $inc: { balanceSyncAttempts: 1 }
      });
    }
  }

  // Sync specific user immediately (for real-time updates)
  async syncUserBalanceNow(userId) {
    try {
      const user = await User.findById(userId).select('_id walletAddress firstName').lean();
      if (!user?.walletAddress) return null;

      await this.syncUserBalance(user);
      
      // Return updated user data
      return await User.findById(userId).select('cachedSolBalance cachedGambinoBalance cachedUsdcBalance balanceLastUpdated');
    } catch (error) {
      console.error('Immediate sync error:', error);
      return null;
    }
  }

  // Utility delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get service status
  getStatus() {
    return {
      isRunning: this.isRunning,
      nextSync: this.syncInterval ? 'Active' : 'Stopped',
      rateLimitDelay: this.rateLimitDelay,
      batchSize: this.batchSize
    };
  }
}

// Export singleton instance
module.exports = new BalanceSyncService();