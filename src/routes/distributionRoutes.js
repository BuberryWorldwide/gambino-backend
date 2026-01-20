// src/routes/distributionRoutes.js
const express = require('express');
const router = express.Router();

// Treasury wallet accounts - Production addresses
const TREASURY_ACCOUNTS = [
  {
    name: 'Mining Rewards',
    address: '8VegmYGeSSohcSDYP2BxGnNSCoksUUC1M3Shyyek4CXT',
    balance: 489500000,
    type: 'mining',
    percentage: 70
  },
  {
    name: 'Founder',
    address: '3WAnmfvZXhNQWeyDioCoNor3YwxoHRpsowbVFj4RfpoA',
    balance: 139800000,
    type: 'founder',
    percentage: 20
  },
  {
    name: 'Operations',
    address: 'DznoYXb12MEPGDZgzA2bamNEMDSt1WENjZPardQKaa2z',
    balance: 35000000,
    type: 'operations',
    percentage: 5
  },
  {
    name: 'Community',
    address: '52GwwDvvdaKxJk39J6QMQ72aqD3LYe49hHdKfJZW7d8q',
    balance: 35000000,
    type: 'community',
    percentage: 5
  }
];

// GET /api/distribution/balances
router.get('/balances', async (req, res) => {
  try {
    const totalBalance = TREASURY_ACCOUNTS.reduce((sum, acc) => sum + acc.balance, 0);

    res.json({
      success: true,
      balances: TREASURY_ACCOUNTS,
      summary: {
        totalAccounts: TREASURY_ACCOUNTS.length,
        totalBalance,
        lastUpdated: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching balances:', error);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

// GET /api/distribution/history
router.get('/history', async (req, res) => {
  try {
    // Return empty array for now - you can add real transaction history later
    res.json({
      success: true,
      distributions: [],
      pagination: {
        limit: parseInt(req.query.limit) || 10,
        offset: parseInt(req.query.offset) || 0,
        total: 0
      }
    });
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/distribution/stats
router.get('/stats', async (req, res) => {
  try {
    const totalBalance = TREASURY_ACCOUNTS.reduce((sum, acc) => sum + acc.balance, 0);

    res.json({
      success: true,
      stats: {
        totalDistributed: 0,
        distributionCount: 0,
        averageDistribution: 0,
        totalBalance,
        period: req.query.period || 'daily'
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/distribution/distribute
router.post('/distribute', async (req, res) => {
  try {
    const { venueId, venueName, recipient, amount, sourceAccount, metadata } = req.body;

    // Validate inputs
    if (!recipient || !amount || !sourceAccount) {
      return res.status(400).json({
        error: 'Missing required fields: recipient, amount, sourceAccount'
      });
    }

    // For now, return a mock response
    // TODO: Implement actual blockchain transaction
    res.json({
      success: true,
      signature: 'MOCK_SIGNATURE_' + Date.now(),
      amount,
      recipient,
      sourceAccount,
      timestamp: new Date().toISOString(),
      message: 'Distribution feature coming soon. This is a preview interface.'
    });
  } catch (error) {
    console.error('Error distributing tokens:', error);
    res.status(500).json({ error: 'Failed to distribute tokens' });
  }
});

module.exports = router;
