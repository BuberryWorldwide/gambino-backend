// backend/src/services/gambinoTokenService.js
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, transfer } = require('@solana/spl-token');
const CredentialManager = require('./credentialManager');

class GambinoTokenService {
  constructor() {
    this.connection = new Connection('https://api.devnet.solana.com', 'confirmed');
    this.credentialManager = new CredentialManager();
    
    // Token configuration - these should be in your .env
    this.gambinoMint = process.env.GAMBINO_MINT_ADDRESS; // From your token minting
    this.decimals = 6;
    
    // Reward amounts (in GAMBINO tokens)
    this.rewards = {
      userRegistration: 1000,    // 1,000 GAMBINO for signing up
      firstLogin: 500,           // 500 GAMBINO for first login
      emailVerification: 250,    // 250 GAMBINO for verifying email
      firstMachinePlay: 2000,    // 2,000 GAMBINO for first machine play
      dailyBonus: 100,           // 100 GAMBINO daily login bonus
      referralBonus: 5000        // 5,000 GAMBINO for successful referral
    };
    
    // Treasury pools that can distribute tokens
    this.treasuryPools = {
      communityRewards: 'communityRewards',  // For user onboarding
      marketing: 'marketing',                // For promotional rewards
      operationsReserve: 'operationsReserve' // For operational bonuses
    };
  }

  async distributeRegistrationReward(userId, userWalletAddress, rewardType = 'userRegistration') {
    try {
      console.log(`🎁 Distributing ${rewardType} reward to user ${userId}`);
      
      // Get reward amount
      const rewardAmount = this.rewards[rewardType];
      if (!rewardAmount) {
        throw new Error(`Unknown reward type: ${rewardType}`);
      }
      
      // Select appropriate treasury pool
      const sourcePool = rewardType === 'referralBonus' ? 
        this.treasuryPools.marketing : 
        this.treasuryPools.communityRewards;
      
      // Execute the token transfer
      const result = await this.transferFromTreasury(
        sourcePool,
        userWalletAddress,
        rewardAmount,
        `${rewardType} reward for user ${userId}`
      );
      
      if (result.success) {
        // Log the reward for treasury tracking
        await this.logRewardDistribution(userId, rewardType, rewardAmount, result.txSignature);
        
        console.log(`✅ ${rewardAmount} GAMBINO sent to ${userWalletAddress}`);
        console.log(`📝 Transaction: ${result.txSignature}`);
        
        return {
          success: true,
          amount: rewardAmount,
          transaction: result.txSignature,
          treasuryPool: sourcePool
        };
      } else {
        throw new Error(result.error);
      }
      
    } catch (error) {
      console.error(`❌ Failed to distribute ${rewardType} reward:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async transferFromTreasury(treasuryAccountType, recipientWalletAddress, amount, memo) {
    try {
      // Get treasury credentials
      const treasuryResult = await this.credentialManager.getKeypair(treasuryAccountType, 'TOKEN_DISTRIBUTION');
      if (!treasuryResult.success) {
        throw new Error(`Failed to get treasury credentials for ${treasuryAccountType}`);
      }
      
      const treasuryKeypair = treasuryResult.keypair;
      
      // Get payer for transaction fees
      const payerResult = await this.credentialManager.getKeypair('payer', 'TOKEN_DISTRIBUTION');
      if (!payerResult.success) {
        throw new Error('Failed to get payer credentials');
      }
      
      const payer = payerResult.keypair;
      
      // Convert amount to token units (with decimals)
      const tokenAmount = amount * Math.pow(10, this.decimals);
      
      // Get treasury token account
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.gambinoMint),
        treasuryKeypair.publicKey
      );
      
      // Get or create recipient token account
      const recipientTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.gambinoMint),
        new PublicKey(recipientWalletAddress)
      );
      
      // Execute transfer
      const txSignature = await transfer(
        this.connection,
        payer,                    // Fee payer
        treasuryTokenAccount,     // Source account
        recipientTokenAccount,    // Destination account
        treasuryKeypair,          // Owner of source account
        tokenAmount,              // Amount with decimals
        [],                       // Multi-signers (none)
        { commitment: 'confirmed' }
      );
      
      console.log(`💸 Transferred ${amount} GAMBINO from ${treasuryAccountType}`);
      console.log(`📋 Memo: ${memo}`);
      
      return {
        success: true,
        txSignature,
        amount,
        treasuryAccount: treasuryAccountType
      };
      
    } catch (error) {
      console.error('❌ Treasury transfer failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async logRewardDistribution(userId, rewardType, amount, txSignature) {
    // This would typically save to your database
    const rewardLog = {
      userId,
      rewardType,
      amount,
      txSignature,
      timestamp: new Date(),
      treasuryImpact: {
        pool: rewardType === 'referralBonus' ? 'marketing' : 'communityRewards',
        amountDeducted: amount
      }
    };
    
    // Save to MongoDB or your preferred database
    // await RewardLog.create(rewardLog);
    
    console.log(`📊 Reward logged: ${JSON.stringify(rewardLog)}`);
    return rewardLog;
  }

  async checkUserEligibility(userId, rewardType) {
    // Check if user has already received this reward
    // This would query your database
    
    const eligibilityRules = {
      userRegistration: () => true, // Always eligible on registration
      firstLogin: (user) => !user.hasReceivedFirstLoginBonus,
      emailVerification: (user) => user.isVerified && !user.hasReceivedVerificationBonus,
      firstMachinePlay: (user) => !user.hasPlayedMachine,
      dailyBonus: (user) => this.canReceiveDailyBonus(user),
      referralBonus: (referrer, referee) => this.validateReferral(referrer, referee)
    };
    
    // For now, return true - implement real checks based on your user model
    return true;
  }

  async getTreasuryPoolBalance(poolType) {
    try {
      const treasuryResult = await this.credentialManager.getKeypair(poolType, 'BALANCE_CHECK');
      if (!treasuryResult.success) {
        throw new Error(`Failed to get ${poolType} credentials`);
      }
      
      const treasuryKeypair = treasuryResult.keypair;
      
      // Get treasury token account
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.gambinoMint),
        treasuryKeypair.publicKey
      );
      
      // Get balance
      const balance = await this.connection.getTokenAccountBalance(treasuryTokenAccount);
      const tokenBalance = balance.value.uiAmount;
      
      return {
        success: true,
        pool: poolType,
        balance: tokenBalance,
        balanceRaw: balance.value.amount
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAllTreasuryBalances() {
    const balances = {};
    
    for (const [poolName, poolType] of Object.entries(this.treasuryPools)) {
      const balance = await this.getTreasuryPoolBalance(poolType);
      balances[poolName] = balance;
    }
    
    return balances;
  }
}

module.exports = GambinoTokenService;

// backend/src/routes/authRoutes.js - UPDATE YOUR EXISTING REGISTRATION
// Add this to your existing user registration endpoint

const GambinoTokenService = require('../services/gambinoTokenService');
const gambinoService = new GambinoTokenService();

// Example integration in your existing registration route
const handleUserRegistration = async (req, res) => {
  try {
    // Your existing registration logic...
    const newUser = await User.create({
      firstName,
      lastName,
      email,
      // ... other user fields
    });
    
    // Generate user's GAMBINO wallet if they don't have one
    if (!newUser.walletAddress) {
      // You could generate a new wallet or use their provided address
      const userWallet = await generateUserWallet(newUser._id);
      newUser.walletAddress = userWallet.publicKey;
      await newUser.save();
    }
    
    // Distribute registration reward
    console.log(`🎁 Sending registration reward to new user: ${newUser.email}`);
    const rewardResult = await gambinoService.distributeRegistrationReward(
      newUser._id,
      newUser.walletAddress,
      'userRegistration'
    );
    
    if (rewardResult.success) {
      // Update user's GAMBINO balance in database
      newUser.gambinoBalance = (newUser.gambinoBalance || 0) + rewardResult.amount;
      newUser.hasReceivedRegistrationBonus = true;
      newUser.registrationRewardTx = rewardResult.transaction;
      await newUser.save();
      
      console.log(`✅ User ${newUser.email} received ${rewardResult.amount} GAMBINO`);
    } else {
      console.error(`❌ Failed to send registration reward: ${rewardResult.error}`);
      // Don't fail registration if reward fails, just log it
    }
    
    res.status(201).json({
      success: true,
      user: newUser.toSafeObject(),
      welcome: {
        gambinoReward: rewardResult.success ? rewardResult.amount : 0,
        message: rewardResult.success ? 
          `Welcome! You've received ${rewardResult.amount} GAMBINO tokens!` :
          'Welcome to Gambino! Tokens will be credited shortly.'
      }
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

// backend/src/routes/treasuryRoutes.js - ADD TREASURY MONITORING
const express = require('express');
const router = express.Router();
const GambinoTokenService = require('../services/gambinoTokenService');
const { authenticateAdmin } = require('../middleware/auth');

const gambinoService = new GambinoTokenService();

// Get all treasury pool balances
router.get('/treasury/balances', authenticateAdmin, async (req, res) => {
  try {
    const balances = await gambinoService.getAllTreasuryBalances();
    
    res.json({
      success: true,
      treasuryPools: balances,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Treasury balance error:', error);
    res.status(500).json({ error: 'Failed to fetch treasury balances' });
  }
});

// Get reward distribution history
router.get('/treasury/reward-history', authenticateAdmin, async (req, res) => {
  try {
    // This would query your reward logs from the database
    // For now, return mock data
    const rewardHistory = [
      {
        userId: 'user123',
        userEmail: 'user@example.com',
        rewardType: 'userRegistration',
        amount: 1000,
        timestamp: new Date(),
        txSignature: 'mock_signature_123'
      }
    ];
    
    res.json({
      success: true,
      rewardHistory,
      totalDistributed: rewardHistory.reduce((sum, r) => sum + r.amount, 0)
    });
    
  } catch (error) {
    console.error('Reward history error:', error);
    res.status(500).json({ error: 'Failed to fetch reward history' });
  }
});

// Manual reward distribution (admin only)
router.post('/treasury/distribute-reward', authenticateAdmin, async (req, res) => {
  try {
    const { userId, walletAddress, rewardType, amount } = req.body;
    
    if (!userId || !walletAddress || !rewardType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const result = await gambinoService.distributeRegistrationReward(
      userId,
      walletAddress,
      rewardType
    );
    
    res.json({
      success: result.success,
      distribution: result,
      message: result.success ? 
        `Distributed ${result.amount} GAMBINO to user ${userId}` :
        `Failed to distribute reward: ${result.error}`
    });
    
  } catch (error) {
    console.error('Manual distribution error:', error);
    res.status(500).json({ error: 'Failed to distribute reward' });
  }
});

module.exports = router;
