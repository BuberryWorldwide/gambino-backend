// backend/src/routes/mobile.js
// Credits and escrow management for mobile mining app
const express = require('express');
const router = express.Router();

let EscrowBalance, MobileCredit, authenticate;

function setupMobileRoutes(deps) {
  EscrowBalance = deps.EscrowBalance;
  MobileCredit = deps.MobileCredit;
  authenticate = deps.authenticate;
  return router;
}

/**
 * GET /api/mobile/escrow/balance
 * Get user's mining rewards escrow balance
 */
router.get('/escrow/balance', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const escrow = await EscrowBalance.getOrCreate(userId);

    res.json({
      success: true,
      balance: escrow.balance,
      pendingDeposits: escrow.pendingDeposits || 0,
      pendingWithdrawals: escrow.pendingWithdrawals || 0,
      lifetimeEarned: escrow.lifetimeEarned || 0,
      lifetimeWithdrawn: escrow.lifetimeWithdrawn || 0,
      lastUpdated: escrow.lastUpdated
    });

  } catch (error) {
    console.error('Get escrow balance error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get escrow balance' 
    });
  }
});

/**
 * GET /api/mobile/credits/balance
 * Get user's mobile app credits balance
 */
router.get('/credits/balance', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;
    const credit = await MobileCredit.getOrCreate(userId);

    res.json({
      success: true,
      credits: credit.credits || 0,
      lifetimePurchased: credit.lifetimePurchased || 0,
      lifetimeSpent: credit.lifetimeSpent || 0,
      lastPurchase: credit.lastPurchase,
      recentTransactions: (credit.recentTransactions || []).slice(0, 10)
    });

  } catch (error) {
    console.error('Get credit balance error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get credit balance' 
    });
  }
});

/**
 * POST /api/mobile/credits/purchase
 * Purchase mobile credits (from escrow or external payment)
 */
router.post('/credits/purchase', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const { quantity, paymentMethod } = req.body;
    const userId = req.user.userId;

    // Validate quantity
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid quantity' 
      });
    }

    // Get credit account
    const credit = await MobileCredit.getOrCreate(userId);

    // Process payment based on method
    let paymentSuccess = false;
    let paymentDetails = {};

    if (paymentMethod === 'escrow') {
      // Pay using escrow balance
      const escrow = await EscrowBalance.findOne({ userId });
      if (!escrow || escrow.balance < quantity) {
        return res.status(400).json({ 
          success: false,
          error: 'Insufficient escrow balance' 
        });
      }

      await escrow.withdraw(quantity);
      paymentSuccess = true;
      paymentDetails = { method: 'escrow', amount: quantity };

    } else if (paymentMethod === 'stripe' || paymentMethod === 'external') {
      // TODO: Implement external payment processing
      // For now, just grant credits (you'll add Stripe integration later)
      paymentSuccess = true;
      paymentDetails = { method: paymentMethod, amount: quantity };
    } else {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid payment method' 
      });
    }

    if (paymentSuccess) {
      await credit.purchase(quantity, `Credit purchase via ${paymentMethod}`);

      console.log(`✅ Credits purchased: ${quantity} for user ${userId} via ${paymentMethod}`);

      res.json({
        success: true,
        newBalance: credit.credits,
        purchased: quantity,
        paymentMethod
      });
    }

  } catch (error) {
    console.error('Purchase credits error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to purchase credits' 
    });
  }
});

/**
 * POST /api/mobile/credits/use
 * Use credits for app features (powerups, etc)
 */
router.post('/credits/use', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const { quantity, description } = req.body;
    const userId = req.user.userId;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid quantity' 
      });
    }

    const credit = await MobileCredit.getOrCreate(userId);

    if (credit.credits < quantity) {
      return res.status(400).json({ 
        success: false,
        error: 'Insufficient credits' 
      });
    }

    await credit.spend(quantity, description || 'Credit usage');

    console.log(`✅ Credits used: ${quantity} by user ${userId}`);

    res.json({
      success: true,
      newBalance: credit.credits,
      used: quantity
    });

  } catch (error) {
    console.error('Use credits error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to use credits' 
    });
  }
});

/**
 * POST /api/mobile/escrow/withdraw
 * Withdraw mining rewards from escrow to wallet
 */
router.post('/escrow/withdraw', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const { amount, destination } = req.body;
    const userId = req.user.userId;

    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid amount' 
      });
    }

    const escrow = await EscrowBalance.findOne({ userId });
    if (!escrow) {
      return res.status(404).json({ 
        success: false,
        error: 'Escrow account not found' 
      });
    }

    if (amount > escrow.balance) {
      return res.status(400).json({ 
        success: false,
        error: 'Insufficient balance' 
      });
    }

    // TODO: Implement actual withdrawal to Solana wallet
    // For now, just update escrow balance
    await escrow.withdraw(amount);

    console.log(`✅ Escrow withdrawal: ${amount} for user ${userId}`);

    res.json({
      success: true,
      withdrawn: amount,
      newBalance: escrow.balance,
      destination: destination || 'pending',
      message: 'Withdrawal initiated'
    });

  } catch (error) {
    console.error('Escrow withdrawal error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Failed to process withdrawal' 
    });
  }
});

/**
 * GET /api/mobile/account/summary
 * Get complete account summary for mobile app dashboard
 */
router.get('/account/summary', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => err ? reject(err) : resolve());
    });

    const userId = req.user.userId;

    // Get all balances
    const [escrow, credit] = await Promise.all([
      EscrowBalance.getOrCreate(userId),
      MobileCredit.getOrCreate(userId)
    ]);

    res.json({
      success: true,
      escrow: {
        balance: escrow.balance,
        lifetimeEarned: escrow.lifetimeEarned || 0,
        lifetimeWithdrawn: escrow.lifetimeWithdrawn || 0
      },
      credits: {
        balance: credit.credits || 0,
        lifetimePurchased: credit.lifetimePurchased || 0,
        lifetimeSpent: credit.lifetimeSpent || 0
      },
      lastUpdated: new Date()
    });

  } catch (error) {
    console.error('Get account summary error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to get account summary' 
    });
  }
});

module.exports = { router, setupMobileRoutes };