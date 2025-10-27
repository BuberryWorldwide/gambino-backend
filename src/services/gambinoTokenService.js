// backend/src/services/gambinoTokenService.js
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, transfer, getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');
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

  // Create token account for a user wallet
  async createUserTokenAccount(userWalletAddress) {
    try {
      console.log('🏗️ Creating token account for wallet:', userWalletAddress);
      
      const userPublicKey = new PublicKey(userWalletAddress);
      const payerKeypair = await this.credentialManager.getKeypair('payer');
      
      if (!payerKeypair.success) {
        throw new Error('Failed to get payer credentials');
      }
      
      // Get or create associated token account
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        payerKeypair.keypair,
        new PublicKey(process.env.GAMBINO_MINT_ADDRESS),
        userPublicKey
      );
      
      console.log('✅ Token account created/found:', tokenAccount.address.toString());
      
      return {
        success: true,
        tokenAccount: tokenAccount.address.toString(),
        mint: this.gambinoMint.toString(),
        owner: userWalletAddress
      };
      
    } catch (error) {
      console.error('❌ Token account creation failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

}

module.exports = GambinoTokenService;