// === WALLET SERVICE ===

const { StoreWallet, WalletTransaction, Settlement } = require('../models/Wallet');
const { Session } = require('../models/Session');
const mongoose = require('mongoose');


class WalletService {
  constructor() {
    this.MINIMUM_CASHOUT = 5.00; // Minimum $5 cash out
    this.MAXIMUM_BALANCE = 10000.00; // Maximum $10k balance per store
  }

  // === CORE WALLET OPERATIONS ===

  async getOrCreateWallet(userId, storeId) {
    try {
      let wallet = await StoreWallet.findOne({ userId, storeId });
      
      if (!wallet) {
        wallet = await StoreWallet.create({
          userId,
          storeId,
          balance: 0
        });
        console.log(`✅ Created new wallet for user ${userId} at store ${storeId}`);
      }
      
      return wallet;
    } catch (error) {
      console.error('❌ Error getting/creating wallet:', error);
      throw new Error('Failed to access wallet');
    }
  }

  async getWalletBalance(userId, storeId) {
    const wallet = await this.getOrCreateWallet(userId, storeId);
    return {
      balance: wallet.balance,
      pendingCredits: wallet.pendingCredits,
      pendingDebits: wallet.pendingDebits,
      availableBalance: wallet.balance - wallet.pendingDebits,
      lastUpdated: wallet.lastUpdated
    };
  }

  // === TRANSACTION PROCESSING ===

  async processTransaction(transactionData) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        userId,
        storeId,
        type,
        amount,
        sessionId = null,
        machineId = null,
        hubMachineId = null,
        sourceEventId = null,
        description = '',
        metadata = {}
      } = transactionData;

      // Validate transaction
      await this.validateTransaction(transactionData);

      // Get wallet with session lock
      const wallet = await StoreWallet.findOne({ userId, storeId }).session(session);
      if (!wallet) {
        throw new Error(`Wallet not found for user ${userId} at store ${storeId}`);
      }

      // Calculate new balance
      const direction = this.getTransactionDirection(type);
      const balanceBefore = wallet.balance;
      let balanceAfter;

      if (direction === 'credit') {
        balanceAfter = balanceBefore + amount;
        if (balanceAfter > this.MAXIMUM_BALANCE) {
          throw new Error(`Transaction would exceed maximum balance of $${this.MAXIMUM_BALANCE}`);
        }
      } else {
        balanceAfter = balanceBefore - amount;
        if (balanceAfter < 0) {
          throw new Error('Insufficient balance for transaction');
        }
      }

      // Create transaction record
      const transaction = await WalletTransaction.create([{
        userId,
        storeId,
        type,
        amount,
        direction,
        balanceBefore,
        balanceAfter,
        sessionId,
        machineId,
        hubMachineId,
        sourceEventId,
        description,
        metadata,
        status: 'confirmed'
      }], { session });

      // Update wallet balance
      await StoreWallet.updateOne(
        { userId, storeId },
        {
          balance: balanceAfter,
          lastUpdated: new Date(),
          lastSessionId: sessionId,
          $inc: { version: 1 }
        },
        { session }
      );

      await session.commitTransaction();

      console.log(`✅ Transaction ${transaction[0].transactionId}: ${direction} $${amount} for user ${userId}`);
      
      return {
        success: true,
        transaction: transaction[0],
        newBalance: balanceAfter
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Transaction failed:', error);
      
      // Create failed transaction record for audit
      try {
        await WalletTransaction.create({
          ...transactionData,
          direction: this.getTransactionDirection(transactionData.type),
          balanceBefore: 0,
          balanceAfter: 0,
          status: 'failed',
          errorMessage: error.message
        });
      } catch (auditError) {
        console.error('❌ Failed to create audit record:', auditError);
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  // === SPECIFIC TRANSACTION TYPES ===

  async processCashDeposit(userId, storeId, amount, sessionId, machineId, hubMachineId, sourceEventId) {
    return await this.processTransaction({
      userId,
      storeId,
      type: 'cash_deposit',
      amount,
      sessionId,
      machineId,
      hubMachineId,
      sourceEventId,
      description: `Cash deposit at machine ${machineId}`,
      metadata: {
        source: 'mutha_goose',
        eventType: 'money_in'
      }
    });
  }

  async processGameWin(userId, storeId, amount, sessionId, machineId, hubMachineId, sourceEventId) {
    return await this.processTransaction({
      userId,
      storeId,
      type: 'gaming_win',
      amount,
      sessionId,
      machineId,
      hubMachineId,
      sourceEventId,
      description: `Game winnings at machine ${machineId}`,
      metadata: {
        source: 'mutha_goose',
        eventType: 'voucher'
      }
    });
  }

  async processGameSpend(userId, storeId, amount, sessionId, machineId, metadata = {}) {
    return await this.processTransaction({
      userId,
      storeId,
      type: 'gaming_spend',
      amount,
      sessionId,
      machineId,
      description: `Gaming spend at machine ${machineId}`,
      metadata: {
        ...metadata,
        source: 'game_session'
      }
    });
  }

  async processCashOut(userId, storeId, amount, sessionId, metadata = {}) {
    // Validate minimum cash out
    if (amount < this.MINIMUM_CASHOUT) {
      throw new Error(`Minimum cash out amount is $${this.MINIMUM_CASHOUT}`);
    }

    const result = await this.processTransaction({
      userId,
      storeId,
      type: 'cash_out',
      amount,
      sessionId,
      description: `Cash out request`,
      metadata: {
        ...metadata,
        cashOutMethod: 'voucher', // or 'manual'
        requiresApproval: amount > 100 // Flag large cash outs
      }
    });

    // Create settlement record for immediate processing
    await this.createCashOutSettlement(userId, storeId, amount, result.transaction.transactionId);

    return result;
  }

  // === SETTLEMENT OPERATIONS ===

  async createCashOutSettlement(userId, storeId, amount, transactionId) {
    try {
      const settlement = await Settlement.create({
        storeId,
        periodStart: new Date(),
        periodEnd: new Date(),
        totalCashOut: amount,
        transactionCount: 1,
        uniqueUsers: 1,
        netAmount: -amount,
        status: 'pending',
        notes: `Individual cash out: Transaction ${transactionId}`
      });

      // Update transaction with settlement ID
      await WalletTransaction.updateOne(
        { transactionId },
        { settlementId: settlement.settlementId }
      );

      return settlement;
    } catch (error) {
      console.error('❌ Failed to create cash out settlement:', error);
      throw error;
    }
  }

  async processEndOfShiftSettlement(storeId, shiftStart, shiftEnd) {
    try {
      const transactions = await WalletTransaction.find({
        storeId,
        createdAt: { $gte: shiftStart, $lte: shiftEnd },
        status: 'confirmed',
        settlementId: null
      });

      if (transactions.length === 0) {
        return { message: 'No transactions to settle' };
      }

      // Calculate totals
      const summary = this.calculateSettlementSummary(transactions);
      
      const settlement = await Settlement.create({
        storeId,
        periodStart: shiftStart,
        periodEnd: shiftEnd,
        ...summary,
        status: 'completed',
        processedAt: new Date(),
        processedBy: 'system'
      });

      // Update transactions with settlement ID
      await WalletTransaction.updateMany(
        { _id: { $in: transactions.map(t => t._id) } },
        { settlementId: settlement.settlementId }
      );

      console.log(`✅ Settlement ${settlement.settlementId} completed for store ${storeId}`);
      return settlement;

    } catch (error) {
      console.error('❌ Settlement processing failed:', error);
      throw error;
    }
  }

  // === HELPER METHODS ===

  getTransactionDirection(type) {
    const creditTypes = ['cash_deposit', 'gaming_win', 'adjustment'];
    return creditTypes.includes(type) ? 'credit' : 'debit';
  }

  async validateTransaction(transactionData) {
    const { userId, storeId, type, amount } = transactionData;

    if (!userId || !storeId || !type || amount <= 0) {
      throw new Error('Invalid transaction data');
    }

    if (amount > 10000) {
      throw new Error('Transaction amount exceeds maximum limit');
    }

    // Additional validations based on type
    if (type === 'cash_out' || type === 'gaming_spend') {
      const wallet = await this.getOrCreateWallet(userId, storeId);
      if (wallet.balance < amount) {
        throw new Error('Insufficient balance');
      }
    }
  }

  calculateSettlementSummary(transactions) {
    const summary = {
      totalCashIn: 0,
      totalCashOut: 0,
      totalGameWins: 0,
      totalGameSpend: 0,
      transactionCount: transactions.length,
      uniqueUsers: new Set(transactions.map(t => t.userId.toString())).size
    };

    transactions.forEach(tx => {
      switch (tx.type) {
        case 'cash_deposit':
          summary.totalCashIn += tx.amount;
          break;
        case 'cash_out':
          summary.totalCashOut += tx.amount;
          break;
        case 'gaming_win':
          summary.totalGameWins += tx.amount;
          break;
        case 'gaming_spend':
          summary.totalGameSpend += tx.amount;
          break;
      }
    });

    summary.netAmount = summary.totalCashIn + summary.totalGameWins - summary.totalCashOut - summary.totalGameSpend;
    return summary;
  }

  // === QUERY METHODS ===

  async getTransactionHistory(userId, storeId, options = {}) {
    const {
      limit = 50,
      offset = 0,
      startDate = null,
      endDate = null,
      type = null
    } = options;

    const query = { userId, storeId };
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    if (type) query.type = type;

    return await WalletTransaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  async getStoreWalletSummary(storeId) {
    const [wallets, recentTransactions] = await Promise.all([
      StoreWallet.aggregate([
        { $match: { storeId } },
        {
          $group: {
            _id: null,
            totalBalance: { $sum: '$balance' },
            totalWallets: { $sum: 1 },
            activeWallets: {
              $sum: {
                $cond: [{ $gt: ['$balance', 0] }, 1, 0]
              }
            }
          }
        }
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            storeId,
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        }
      ])
    ]);

    return {
      summary: wallets[0] || { totalBalance: 0, totalWallets: 0, activeWallets: 0 },
      recentActivity: recentTransactions
    };
  }
}

module.exports = WalletService;