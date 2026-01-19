// src/services/CashoutService.js
const mongoose = require('mongoose');
const ExchangeRateConfig = require('../models/ExchangeRateConfig');

class CashoutService {
  /**
   * Get current exchange rate configuration
   */
  static async getCurrentExchangeRate() {
    const config = await ExchangeRateConfig.getCurrentConfig();

    if (!config) {
      // Return default config if none exists
      return {
        tokensPerDollar: 1000,
        minCashout: 5,
        maxCashoutPerTransaction: 500,
        dailyLimitPerCustomer: 1000,
        dailyLimitPerStaff: 5000,
        venueCommissionPercent: 0
      };
    }

    return config;
  }

  /**
   * Validate cashout request
   */
  static async validateCashout(customerId, tokensToConvert, storeId, staffId) {
    const errors = [];

    // Get User and Transaction models from mongoose (they're registered in server.js)
    const User = mongoose.model('User');
    const Transaction = mongoose.model('Transaction');

    // 1. Get customer
    const customer = await User.findById(customerId);
    if (!customer) {
      errors.push('Customer not found');
      return { valid: false, errors };
    }

    // 2. Get exchange rate config
    const config = await this.getCurrentExchangeRate();

    // 3. Check minimum tokens
    const minTokens = config.minCashout * config.tokensPerDollar;
    if (tokensToConvert < minTokens) {
      errors.push(`Minimum cashout is ${minTokens} tokens ($${config.minCashout})`);
    }

    // 4. Check maximum tokens
    const maxTokens = config.maxCashoutPerTransaction * config.tokensPerDollar;
    if (tokensToConvert > maxTokens) {
      errors.push(`Maximum cashout is ${maxTokens} tokens ($${config.maxCashoutPerTransaction})`);
    }

    // 5. Check customer balance
    const currentBalance = customer.gambinoBalance || 0;
    if (tokensToConvert > currentBalance) {
      errors.push(`Insufficient balance. Available: ${currentBalance} tokens, Requested: ${tokensToConvert} tokens`);
    }

    // 6. Check daily limit for customer
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const customerDailyCashouts = await Transaction.aggregate([
      {
        $match: {
          userId: customer._id,
          type: 'cashout',
          status: 'completed',
          createdAt: { $gte: today, $lt: tomorrow }
        }
      },
      {
        $group: {
          _id: null,
          totalCashAmount: { $sum: '$usdAmount' }
        }
      }
    ]);

    const customerTodayTotal = customerDailyCashouts[0]?.totalCashAmount || 0;
    const requestCashAmount = tokensToConvert / config.tokensPerDollar;

    if (customerTodayTotal + requestCashAmount > config.dailyLimitPerCustomer) {
      errors.push(`Daily cashout limit exceeded. Customer limit: $${config.dailyLimitPerCustomer}, Today's total: $${customerTodayTotal.toFixed(2)}`);
    }

    // 7. Check daily limit for staff
    const staffDailyCashouts = await Transaction.aggregate([
      {
        $match: {
          'metadata.staffMemberId': staffId,
          type: 'cashout',
          status: 'completed',
          createdAt: { $gte: today, $lt: tomorrow }
        }
      },
      {
        $group: {
          _id: null,
          totalCashAmount: { $sum: '$usdAmount' }
        }
      }
    ]);

    const staffTodayTotal = staffDailyCashouts[0]?.totalCashAmount || 0;

    if (staffTodayTotal + requestCashAmount > config.dailyLimitPerStaff) {
      errors.push(`Staff daily limit exceeded. Limit: $${config.dailyLimitPerStaff}, Today's total: $${staffTodayTotal.toFixed(2)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      customer,
      config,
      cashAmount: requestCashAmount
    };
  }

  /**
   * Process cashout transaction (ATOMIC)
   */
  static async processCashout(customerId, tokensToConvert, storeId, staffId, notes = '') {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const User = mongoose.model('User');
      const Transaction = mongoose.model('Transaction');

      // 1. Validate cashout
      const validation = await this.validateCashout(customerId, tokensToConvert, storeId, staffId);

      if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
      }

      const { customer, config, cashAmount } = validation;

      // 2. Calculate amounts
      const balanceBefore = customer.gambinoBalance;
      const venueCommission = cashAmount * (config.venueCommissionPercent / 100);
      const cashToCustomer = cashAmount - venueCommission;

      // 3. Generate unique transaction ID
      const transactionId = `TXN-${Date.now()}-${customer._id.toString().slice(-6)}`;

      // 4. Deduct tokens from customer (ATOMIC with session)
      const updateResult = await User.findByIdAndUpdate(
        customerId,
        {
          $inc: {
            gambinoBalance: -tokensToConvert,
            cachedGambinoBalance: -tokensToConvert,
            totalWithdrawn: cashAmount
          },
          $set: {
            lastActivity: new Date(),
            balanceLastUpdated: new Date()
          }
        },
        {
          new: true,
          session,
          runValidators: true
        }
      );

      if (!updateResult) {
        throw new Error('Failed to update customer balance');
      }

      // Verify balance didn't go negative (safety check)
      if (updateResult.gambinoBalance < 0) {
        throw new Error('Transaction would result in negative balance');
      }

      // 5. Create transaction record
      const transaction = new Transaction({
        userId: customer._id,
        type: 'cashout',
        amount: tokensToConvert,
        usdAmount: cashAmount,
        status: 'completed',
        machineId: null,
        txHash: transactionId,
        metadata: {
          storeId,
          staffMemberId: staffId,
          exchangeRate: config.tokensPerDollar,
          cashToCustomer,
          venueCommission,
          commissionPercent: config.venueCommissionPercent,
          balanceBefore,
          balanceAfter: updateResult.gambinoBalance,
          transactionId,
          notes: notes || '',
          processedAt: new Date()
        }
      });

      await transaction.save({ session });

      // 6. Commit transaction
      await session.commitTransaction();

      console.log(`✅ Cashout processed: ${transactionId} - Customer ${customer.email} - ${tokensToConvert} tokens → $${cashAmount.toFixed(2)}`);

      return {
        success: true,
        transaction: {
          _id: transaction._id,
          transactionId,
          customerId: customer._id,
          customerEmail: customer.email,
          customerName: `${customer.firstName} ${customer.lastName}`,
          tokensConverted: tokensToConvert,
          cashAmount,
          cashToCustomer,
          venueCommission,
          exchangeRate: config.tokensPerDollar,
          balanceBefore,
          balanceAfter: updateResult.gambinoBalance,
          status: 'completed',
          createdAt: transaction.createdAt
        }
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Cashout processing error:', error);

      return {
        success: false,
        error: error.message
      };
    } finally {
      session.endSession();
    }
  }

  /**
   * Get cashout history for a store
   */
  static async getCashoutHistory(storeId, filters = {}) {
    const Transaction = mongoose.model('Transaction');

    const {
      startDate,
      endDate,
      customerId,
      staffMemberId,
      status = 'completed',
      limit = 50,
      offset = 0
    } = filters;

    const query = {
      'metadata.storeId': storeId,
      type: 'cashout'
    };

    if (status !== 'all') {
      query.status = status;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (customerId) {
      query.userId = mongoose.Types.ObjectId(customerId);
    }

    if (staffMemberId) {
      query['metadata.staffMemberId'] = staffMemberId;
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .populate('userId', 'firstName lastName email phone')
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(offset)
        .lean(),
      Transaction.countDocuments(query)
    ]);

    // Calculate summary
    const summary = await Transaction.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalTokensConverted: { $sum: '$amount' },
          totalCashPaid: { $sum: '$usdAmount' },
          totalCommission: { $sum: '$metadata.venueCommission' }
        }
      }
    ]);

    return {
      transactions,
      pagination: {
        total,
        limit,
        offset,
        pages: Math.ceil(total / limit)
      },
      summary: summary[0] || {
        totalTransactions: 0,
        totalTokensConverted: 0,
        totalCashPaid: 0,
        totalCommission: 0
      }
    };
  }

  /**
   * Get daily reconciliation report
   */
  static async getDailyReconciliation(storeId, date) {
    const Transaction = mongoose.model('Transaction');
    const DailyReport = mongoose.model('DailyReport');

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    // Get machine revenue from DailyReport
    const dailyReport = await DailyReport.findOne({
      storeId,
      reportDate: {
        $gte: targetDate,
        $lt: nextDate
      }
    }).lean();

    // Get cashout transactions for the day
    const cashoutSummary = await Transaction.aggregate([
      {
        $match: {
          'metadata.storeId': storeId,
          type: 'cashout',
          status: 'completed',
          createdAt: { $gte: targetDate, $lt: nextDate }
        }
      },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalTokensConverted: { $sum: '$amount' },
          totalCashPaid: { $sum: '$usdAmount' },
          totalCommission: { $sum: '$metadata.venueCommission' }
        }
      }
    ]);

    const cashouts = cashoutSummary[0] || {
      totalTransactions: 0,
      totalTokensConverted: 0,
      totalCashPaid: 0,
      totalCommission: 0
    };

    // Calculate cash flow
    const machineRevenue = {
      totalMoneyIn: dailyReport?.totalMoneyIn || 0,
      totalMoneyOut: dailyReport?.totalCollect || 0,
      netRevenue: dailyReport?.totalRevenue || 0
    };

    return {
      date: targetDate.toISOString().split('T')[0],
      storeId,
      machineRevenue,
      cashouts,
      cashFlow: {
        machineCollections: machineRevenue.totalMoneyIn,
        cashPaidOut: cashouts.totalCashPaid,
        netCashFlow: machineRevenue.totalMoneyIn - cashouts.totalCashPaid,
        commission: cashouts.totalCommission
      }
    };
  }

  /**
   * Reverse a cashout (admin only)
   */
  static async reverseCashout(transactionId, reversedBy, reason) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const Transaction = mongoose.model('Transaction');
      const User = mongoose.model('User');

      // Find the original transaction
      const transaction = await Transaction.findById(transactionId).session(session);

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.type !== 'cashout') {
        throw new Error('Can only reverse cashout transactions');
      }

      if (transaction.status !== 'completed') {
        throw new Error('Can only reverse completed transactions');
      }

      if (transaction.metadata?.reversed) {
        throw new Error('Transaction already reversed');
      }

      // Refund tokens to customer
      await User.findByIdAndUpdate(
        transaction.userId,
        {
          $inc: {
            gambinoBalance: transaction.amount,
            cachedGambinoBalance: transaction.amount,
            totalWithdrawn: -transaction.usdAmount
          },
          $set: {
            lastActivity: new Date(),
            balanceLastUpdated: new Date()
          }
        },
        { session }
      );

      // Update transaction as reversed
      transaction.metadata = {
        ...transaction.metadata,
        reversed: true,
        reversedAt: new Date(),
        reversedBy,
        reversalReason: reason
      };
      transaction.status = 'failed'; // Mark as failed to exclude from reports
      await transaction.save({ session });

      // Create reversal transaction record
      const reversalTransaction = new Transaction({
        userId: transaction.userId,
        type: 'cashout_reversal',
        amount: transaction.amount,
        usdAmount: transaction.usdAmount,
        status: 'completed',
        metadata: {
          originalTransactionId: transaction._id,
          originalTxHash: transaction.txHash,
          reversedBy,
          reversalReason: reason,
          storeId: transaction.metadata.storeId
        }
      });

      await reversalTransaction.save({ session });

      await session.commitTransaction();

      console.log(`✅ Cashout reversed: ${transaction.txHash} by ${reversedBy}`);

      return {
        success: true,
        message: 'Cashout successfully reversed',
        reversalTransaction: reversalTransaction._id
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('❌ Cashout reversal error:', error);

      return {
        success: false,
        error: error.message
      };
    } finally {
      session.endSession();
    }
  }
}

module.exports = CashoutService;
