const express = require('express');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const router = express.Router();

// GET / - Fast leaderboard using cached database balances
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const forceSync = req.query.sync === 'true';

    // If force sync requested, trigger background sync for top holders
    if (forceSync && req.app.locals.balanceSyncService) {
      console.log('Force sync requested for leaderboard');
      req.app.locals.balanceSyncService.batchSync(null, 20);
    }

    // Get leaderboard from cached balances
    const topUsers = await User.find({ 
      isActive: { $ne: false },
      walletAddress: { $exists: true, $ne: null },
      cachedGambinoBalance: { $gt: 0 }
    })
    .sort({ cachedGambinoBalance: -1 })
    .limit(limit)
    .select('firstName lastName email walletAddress cachedGambinoBalance cachedSolBalance cachedUsdcBalance totalJackpots majorJackpots minorJackpots createdAt lastActivity balanceLastUpdated')
    .lean();

    const leaderboard = topUsers.map((user, index) => {
      const lastSyncAge = user.balanceLastUpdated ? 
        Math.round((Date.now() - new Date(user.balanceLastUpdated).getTime()) / (1000 * 60)) : null;
      
      return {
        rank: index + 1,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Anonymous Player',
        email: user.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : 'N/A',
        balance: user.cachedGambinoBalance || 0,
        solBalance: user.cachedSolBalance || 0,
        usdcBalance: user.cachedUsdcBalance || 0,
        
        // Gaming stats
        totalJackpots: user.totalJackpots || 0,
        majorJackpots: user.majorJackpots || 0,
        minorJackpots: user.minorJackpots || 0,
        
        // Account info
        memberSince: user.createdAt,
        lastActive: user.lastActivity,
        wallet: user.walletAddress ? `${user.walletAddress.slice(0,4)}...${user.walletAddress.slice(-4)}` : null,
        
        // Sync status
        lastSyncAgo: lastSyncAge,
        syncStatus: !user.balanceLastUpdated ? 'never' : 
                   (lastSyncAge > 60) ? 'stale' : 'fresh'
      };
    });

    // Calculate stats
    const totalCirculating = leaderboard.reduce((sum, user) => sum + user.balance, 0);
    const top10Share = leaderboard.slice(0, 10).reduce((sum, user) => sum + user.balance, 0);
    const freshSyncs = leaderboard.filter(u => u.syncStatus === 'fresh').length;
    
    res.json({
      success: true,
      leaderboard,
      stats: {
        totalPlayers: leaderboard.length,
        totalCirculating,
        top10Share,
        top10SharePct: totalCirculating > 0 ? ((top10Share / totalCirculating) * 100).toFixed(2) : 0,
        freshSyncs,
        staleSyncs: leaderboard.length - freshSyncs,
        lastUpdated: new Date(),
        dataSource: 'cached_database'
      }
    });

  } catch (error) {
    console.error('Cached leaderboard error:', error);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// GET /jackpots - Leaderboard by jackpot wins
router.get('/jackpots', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

    const topUsers = await User.find({ 
      isActive: { $ne: false },
      totalJackpots: { $gt: 0 }
    })
    .sort({ majorJackpots: -1, minorJackpots: -1 })
    .limit(limit)
    .select('firstName lastName email totalJackpots majorJackpots minorJackpots cachedGambinoBalance createdAt')
    .lean();

    const leaderboard = topUsers.map((user, index) => ({
      rank: index + 1,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Anonymous Player',
      email: user.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : 'N/A',
      totalJackpots: user.totalJackpots || 0,
      majorJackpots: user.majorJackpots || 0,
      minorJackpots: user.minorJackpots || 0,
      currentBalance: user.cachedGambinoBalance || 0,
      memberSince: user.createdAt
    }));

    res.json({
      success: true,
      leaderboard,
      stats: {
        totalWinners: leaderboard.length,
        totalJackpots: leaderboard.reduce((sum, u) => sum + u.totalJackpots, 0),
        totalMajorJackpots: leaderboard.reduce((sum, u) => sum + u.majorJackpots, 0)
      }
    });
  } catch (error) {
    console.error('Jackpot leaderboard error:', error);
    res.status(500).json({ error: 'Failed to load jackpot leaderboard' });
  }
});

// GET /recent-winners - Recent jackpot winners
router.get('/recent-winners', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    const days = Math.min(parseInt(req.query.days || '7', 10), 30);
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const recentWins = await Transaction.find({
      type: 'jackpot',
      status: 'completed',
      createdAt: { $gte: startDate }
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'firstName lastName email')
    .lean();

    const winners = recentWins.map(tx => {
      const user = tx.userId;
      return {
        name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Anonymous' : 'Unknown',
        email: user?.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : 'N/A',
        amount: tx.amount || 0,
        jackpotType: tx.amount > 1000 ? 'Major' : 'Minor',
        wonAt: tx.createdAt,
        machineId: tx.machineId || 'Unknown'
      };
    });

    res.json({
      success: true,
      winners,
      stats: {
        totalWins: winners.length,
        totalPayout: winners.reduce((sum, win) => sum + win.amount, 0),
        majorWins: winners.filter(w => w.jackpotType === 'Major').length,
        minorWins: winners.filter(w => w.jackpotType === 'Minor').length
      }
    });
  } catch (error) {
    console.error('Recent winners error:', error);
    res.status(500).json({ error: 'Failed to load recent winners' });
  }
});

module.exports = router;