const { Connection, PublicKey } = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  transfer,
  getMint
} = require('@solana/spl-token');
const CredentialManager = require('./credentialManager');
const Distribution = require('../models/Distribution');

class DistributionService {
  constructor() {
    this.rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    this.mintAddress = process.env.GAMBINO_MINT_ADDRESS;
    this.credentialManager = new CredentialManager();

    if (!this.mintAddress) {
      throw new Error('GAMBINO_MINT_ADDRESS not set in environment variables');
    }
  }

  /**
   * Map API account names to actual CredentialManager account types
   * This allows flexibility between different treasury structures
   */
  mapAccountType(requestedAccount) {
    const accountMap = {
      // API names -> Actual vault account names
      'miningRewards': 'jackpotReserve',
      'founder': 'teamReserve',
      'operations': 'operationsReserve',
      'community': 'communityRewards',
      // Direct mappings (if already using correct names)
      'jackpotReserve': 'jackpotReserve',
      'operationsReserve': 'operationsReserve',
      'teamReserve': 'teamReserve',
      'communityRewards': 'communityRewards'
    };
    return accountMap[requestedAccount] || requestedAccount;
  }

  /**
   * Distribute GAMBINO tokens from treasury to recipient
   * @param {Object} params - Distribution parameters
   * @param {string} params.venueId - Venue identifier
   * @param {string} params.venueName - Venue name (optional)
   * @param {string} params.recipient - Recipient wallet address
   * @param {number} params.amount - Amount of GAMBINO tokens to send
   * @param {string} params.sourceAccount - Source account ('miningRewards', 'founder', 'operations', 'community')
   * @param {string} params.staffId - Staff member who initiated (optional)
   * @param {string} params.staffEmail - Staff email (optional)
   * @returns {Object} Transaction result with signature
   */
  async distributeTokens({
    venueId,
    venueName,
    recipient,
    amount,
    sourceAccount = 'miningRewards',
    staffId,
    staffEmail,
    metadata = {}
  }) {
    let distribution;

    try {
      // Validate recipient address
      let recipientPubkey;
      try {
        recipientPubkey = new PublicKey(recipient);
      } catch (error) {
        throw new Error(`Invalid recipient address: ${recipient}`);
      }

      // Validate amount
      if (!amount || amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      // Map account name to actual vault account type
      const mappedAccount = this.mapAccountType(sourceAccount);
      console.log(`🔄 Account mapping: ${sourceAccount} -> ${mappedAccount}`);

      // Get source account credentials
      const sourceResult = await this.credentialManager.getKeypair(
        mappedAccount,
        `DISTRIBUTION_${venueId}`
      );

      if (!sourceResult.success) {
        throw new Error(`Failed to access ${mappedAccount} (requested: ${sourceAccount}) account: ${sourceResult.error}`);
      }

      const sourceKeypair = sourceResult.keypair;
      const mintPubkey = new PublicKey(this.mintAddress);

      // Get mint info to determine decimals
      const mintInfo = await getMint(this.connection, mintPubkey);
      const decimals = mintInfo.decimals;

      // Convert amount to token units (amount * 10^decimals)
      const transferAmount = BigInt(Math.floor(amount * Math.pow(10, decimals)));

      // Get or create associated token accounts
      const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        sourceKeypair,
        mintPubkey,
        sourceKeypair.publicKey
      );

      const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        sourceKeypair, // Payer for account creation
        mintPubkey,
        recipientPubkey
      );

      // Check source balance
      if (sourceTokenAccount.amount < transferAmount) {
        const availableBalance = Number(sourceTokenAccount.amount) / Math.pow(10, decimals);
        throw new Error(
          `Insufficient balance. Available: ${availableBalance.toLocaleString()} GAMBINO, ` +
          `Requested: ${amount.toLocaleString()} GAMBINO`
        );
      }

      // Create pending distribution record
      distribution = new Distribution({
        venueId,
        venueName,
        recipient,
        amount,
        signature: 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        status: 'pending',
        sourceAccount,
        staffId,
        staffEmail,
        metadata
      });
      await distribution.save();

      // Execute transfer
      const signature = await transfer(
        this.connection,
        sourceKeypair,
        sourceTokenAccount.address,
        recipientTokenAccount.address,
        sourceKeypair,
        transferAmount
      );

      // Update distribution with signature
      distribution.signature = signature;
      distribution.status = 'confirmed';
      await distribution.save();

      // Get updated balances
      const updatedSourceAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        sourceKeypair,
        mintPubkey,
        sourceKeypair.publicKey
      );

      const newBalance = Number(updatedSourceAccount.amount) / Math.pow(10, decimals);

      return {
        success: true,
        signature,
        amount,
        recipient,
        sourceAccount,
        newBalance,
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${this.rpcUrl.includes('devnet') ? 'devnet' : 'mainnet'}`,
        distributionId: distribution._id
      };

    } catch (error) {
      // Update distribution record with error
      if (distribution) {
        distribution.status = 'failed';
        distribution.error = error.message;
        await distribution.save();
      }

      throw error;
    }
  }

  /**
   * Get distribution history
   * @param {Object} filters - Query filters
   * @param {string} filters.venueId - Filter by venue ID
   * @param {string} filters.recipient - Filter by recipient
   * @param {string} filters.status - Filter by status
   * @param {number} filters.limit - Limit results (default 50)
   * @param {number} filters.skip - Skip results for pagination
   * @returns {Array} Distribution records
   */
  async getDistributionHistory(filters = {}) {
    const query = {};

    if (filters.venueId) query.venueId = filters.venueId;
    if (filters.recipient) query.recipient = filters.recipient;
    if (filters.status) query.status = filters.status;
    if (filters.sourceAccount) query.sourceAccount = filters.sourceAccount;

    const limit = filters.limit || 50;
    const skip = filters.skip || 0;

    const distributions = await Distribution.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate('staffId', 'username email');

    const total = await Distribution.countDocuments(query);

    return {
      distributions,
      total,
      limit,
      skip
    };
  }

  /**
   * Get distribution statistics
   * @param {string} venueId - Venue ID (optional)
   * @param {string} period - 'daily', 'weekly', 'monthly'
   * @returns {Object} Statistics
   */
  async getDistributionStats(venueId, period = 'daily') {
    const now = new Date();
    let startDate;

    switch (period) {
      case 'daily':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'weekly':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'monthly':
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
      default:
        startDate = new Date(now.setHours(0, 0, 0, 0));
    }

    const query = {
      createdAt: { $gte: startDate },
      status: 'confirmed'
    };

    if (venueId) {
      query.venueId = venueId;
    }

    const distributions = await Distribution.find(query);

    const stats = {
      totalDistributed: distributions.reduce((sum, d) => sum + d.amount, 0),
      transactionCount: distributions.length,
      averageAmount: distributions.length > 0
        ? distributions.reduce((sum, d) => sum + d.amount, 0) / distributions.length
        : 0,
      period,
      startDate,
      endDate: new Date()
    };

    return stats;
  }

  /**
   * Get balance for a specific treasury account
   * @param {string} accountType - 'miningRewards', 'founder', 'operations', 'community'
   * @returns {Object} Balance information
   */
  async getTreasuryBalance(accountType) {
    try {
      // Map account name to actual vault account type
      const mappedAccount = this.mapAccountType(accountType);

      const accountResult = await this.credentialManager.getKeypair(
        mappedAccount,
        `BALANCE_CHECK`
      );

      if (!accountResult.success) {
        throw new Error(`Failed to access ${mappedAccount} (requested: ${accountType}) account`);
      }

      const accountKeypair = accountResult.keypair;
      const mintPubkey = new PublicKey(this.mintAddress);
      const mintInfo = await getMint(this.connection, mintPubkey);

      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        accountKeypair,
        mintPubkey,
        accountKeypair.publicKey
      );

      const balance = Number(tokenAccount.amount) / Math.pow(10, mintInfo.decimals);

      return {
        accountType,
        address: accountKeypair.publicKey.toString(),
        balance,
        tokenAddress: tokenAccount.address.toString()
      };
    } catch (error) {
      throw new Error(`Error getting balance for ${accountType}: ${error.message}`);
    }
  }
}

module.exports = DistributionService;
