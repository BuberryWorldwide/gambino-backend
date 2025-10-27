// blockchainTreasuryRoutes.js - Create this file in your backend root directory
require("dotenv").config({ path: "/opt/gambino/.env" });
const express = require("express");
const router = express.Router();
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');

class BlockchainTreasuryService {
  constructor() {
    // Use your exact CLI configuration
    this.network = process.env.SOLANA_NETWORK || 'mainnet-beta';
    this.rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    // Token configuration - exact match to your CLI
    this.gambinoMint = new PublicKey(process.env.GAMBINO_MINT_ADDRESS || 'Cd2wZyKVdWuyuJJHmeU1WmfSKNnDHku2m6mt6XFqGeXn');
    this.tokenDecimals = parseInt(process.env.GAMBINO_DECIMALS || '6');
    
    // Rate limiting from your CLI
    this.rateLimitDelay = Number(process.env.RPC_PACE_MS || 200);
    
    console.log(`Treasury API initialized on ${this.network}`);
    console.log(`RPC URL: ${this.rpcUrl}`);
    console.log(`GAMBINO: ${this.gambinoMint.toBase58()}`);
  }

  // Exact copy of your CLI's sleep function
  async sleep(ms = 0) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Exact copy of your CLI's _getSolBalance method
  async _getSolBalance(pubkey) {
    try {
      const lamports = await this.connection.getBalance(pubkey);
      return lamports / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error(`SOL balance error for ${pubkey.toString()}:`, error.message);
      return 0;
    }
  }

  // Exact copy of your CLI's _getTokenUiAmount method
  async _getTokenUiAmount(ownerPubkey, mintPubkey) {
    try {
      // Exact ATA lookup (no owner scan)
      const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey);
      const acc = await getAccount(this.connection, ata);
      return Number(acc.amount) / (10 ** this.tokenDecimals);
    } catch {
      return 0; // no ATA
    }
  }

  async getAccountBalance(publicKeyString) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      
      // Use your CLI's exact methods
      const solBalance = await this._getSolBalance(publicKey);
      const tokenBalance = await this._getTokenUiAmount(publicKey, this.gambinoMint);
      
      // Get token account if exists
      let tokenAccount = null;
      if (tokenBalance > 0) {
        try {
          const ata = await getAssociatedTokenAddress(this.gambinoMint, publicKey);
          tokenAccount = ata.toString();
        } catch {
          // ignore
        }
      }

      return {
        success: true,
        publicKey: publicKeyString,
        solBalance,
        tokenBalance,
        tokenAccount,
        network: this.network
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        publicKey: publicKeyString
      };
    }
  }

  async getAllTreasuryBalances() {
    try {
      console.log('Fetching all treasury balances from blockchain...');
      
      const accounts = [];
      let totalTokenBalance = 0;
      let totalSolBalance = 0;

      // Use environment variable treasury addresses (like your CLI)
      const envTreasuries = {
        main: process.env.MAIN_TREASURY_PUBLIC_KEY,
        jackpot: process.env.JACKPOT_TREASURY_PUBLIC_KEY, 
        operations: process.env.OPERATIONS_TREASURY_PUBLIC_KEY,
        team: process.env.TEAM_TREASURY_PUBLIC_KEY,
        community: process.env.COMMUNITY_TREASURY_PUBLIC_KEY,
        payer: process.env.PAYER_PUBLIC_KEY
      };

      for (const [name, publicKeyString] of Object.entries(envTreasuries)) {
        if (!publicKeyString) continue;

        try {
          const balance = await this.getAccountBalance(publicKeyString);
          
          if (balance.success) {
            accounts.push({
              accountType: name,
              label: name.toUpperCase(),
              securityLevel: 'MEDIUM',
              publicKey: publicKeyString,
              solBalance: balance.solBalance,
              tokenBalance: balance.tokenBalance,
              tokenAccount: balance.tokenAccount,
              percentage: 0,
              status: 'HEALTHY',
              lastChecked: new Date().toISOString(),
              network: this.network
            });

            totalTokenBalance += balance.tokenBalance;
            totalSolBalance += balance.solBalance;
          }

          // Rate limiting
          if (this.rateLimitDelay > 0) {
            await this.sleep(this.rateLimitDelay);
          }
        } catch (error) {
          console.error(`Error processing ${name}:`, error);
        }
      }

      console.log(`Treasury summary: ${accounts.length} accounts, ${totalSolBalance.toFixed(4)} SOL, ${totalTokenBalance.toLocaleString()} GAMBINO`);

      return {
        success: true,
        accounts,
        summary: {
          totalAccounts: accounts.length,
          totalTokenBalance,
          totalSolBalance,
          healthyAccounts: accounts.filter(a => a.status === 'HEALTHY').length,
          network: this.network,
          tokenSymbol: 'GAMBINO',
          lastUpdated: new Date().toISOString()
        }
      };
      
    } catch (error) {
      console.error('getAllTreasuryBalances error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getNetworkInfo() {
    try {
      const version = await this.connection.getVersion();
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      
      return {
        success: true,
        network: this.network,
        rpcUrl: this.rpcUrl,
        version: version['solana-core'],
        currentSlot: slot,
        blockTime: blockTime ? new Date(blockTime * 1000).toISOString() : null,
        tokenMint: this.gambinoMint.toString(),
        tokenDecimals: this.tokenDecimals
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Initialize the service
const treasuryService = new BlockchainTreasuryService();

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
  // Check if user is authenticated via JWT (from the main auth middleware)
  if (req.user && ['super_admin', 'gambino_ops'].includes(req.user.role)) {
    return next();
  }
  
  // Fallback to admin key if no JWT user
  const adminKey = req.headers['x-admin-key'];
  if (adminKey && adminKey === process.env.ADMIN_API_KEY) {
    return next();
  }
  
  return res.status(401).json({ error: 'Admin access required' });
};

// =================== BLOCKCHAIN TREASURY ROUTES ===================

// Get all treasury account balances from blockchain
router.get('/balances', authenticateAdmin, async (req, res) => {
  try {
    console.log('Fetching all treasury balances from blockchain...');
    
    const result = await treasuryService.getAllTreasuryBalances();
    
    if (!result.success) {
      return res.status(500).json({ 
        error: result.error,
        network: treasuryService.network 
      });
    }

    console.log(`Retrieved balances for ${result.accounts.length} accounts`);
    
    res.json({
      success: true,
      data: result,
      meta: {
        network: treasuryService.network,
        rpcUrl: treasuryService.rpcUrl,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Treasury balances error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch treasury balances',
      network: treasuryService.network 
    });
  }
});

// Get specific account balance
router.get('/balances/:accountType', authenticateAdmin, async (req, res) => {
  try {
    const { accountType } = req.params;
    
    console.log(`Fetching balance for ${accountType}...`);
    
    // Get public key from environment
    const publicKeyString = process.env[`${accountType.toUpperCase()}_TREASURY_PUBLIC_KEY`] || 
                           process.env[`${accountType.toUpperCase()}_PUBLIC_KEY`];
    
    if (!publicKeyString) {
      return res.status(404).json({ 
        error: `Account ${accountType} not found in environment variables` 
      });
    }

    const balance = await treasuryService.getAccountBalance(publicKeyString);
    
    if (!balance.success) {
      return res.status(500).json({ 
        error: balance.error,
        accountType 
      });
    }

    res.json({
      success: true,
      data: {
        accountType,
        label: accountType.toUpperCase(),
        securityLevel: 'MEDIUM',
        ...balance
      },
      meta: {
        network: treasuryService.network,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error(`Account balance error for ${req.params.accountType}:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch account balance',
      accountType: req.params.accountType 
    });
  }
});

// Get network information
router.get('/network', authenticateAdmin, async (req, res) => {
  try {
    const networkInfo = await treasuryService.getNetworkInfo();
    
    res.json({
      success: true,
      data: networkInfo,
      meta: {
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Network info error:', error);
    res.status(500).json({ error: 'Failed to fetch network information' });
  }
});

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    const networkInfo = await treasuryService.getNetworkInfo();
    
    res.json({
      success: true,
      health: {
        network: networkInfo.success ? 'HEALTHY' : 'ERROR',
        service: 'HEALTHY',
        timestamp: new Date().toISOString()
      },
      details: {
        network: networkInfo
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      health: {
        service: 'ERROR',
        timestamp: new Date().toISOString()
      },
      error: error.message
    });
  }
});

module.exports = router;