const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// Get user's owned skins
router.get('/owned', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    // Super admin gets ALL packs
    if (user.role === 'superadmin') {
      return res.json({
        success: true,
        ownedPacks: ['gambino-gold', 'neon-nights', 'luxury-casino'], // All pack IDs
        activePack: user.activeSkinPack || 'gambino-gold',
        isSuperAdmin: true
      });
    }
    
    // Regular users get their purchased packs + default
    const ownedIds = user.ownedSkinPacks?.map(p => p.packId) || [];
    if (!ownedIds.includes('gambino-gold')) {
      ownedIds.unshift('gambino-gold'); // Everyone gets default
    }
    
    res.json({
      success: true,
      ownedPacks: ownedIds,
      activePack: user.activeSkinPack || 'gambino-gold',
      isSuperAdmin: false
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Set active skin (must own it first)
router.post('/activate', authenticateToken, async (req, res) => {
  try {
    const { packId } = req.body;
    const user = await User.findById(req.user.id);
    
    // Check if user owns this pack
    const ownedIds = user.ownedSkinPacks?.map(p => p.packId) || [];
    const canActivate = 
      packId === 'gambino-gold' || // Default is always available
      ownedIds.includes(packId) ||
      user.role === 'superadmin';   // Super admin can use any
    
    if (!canActivate) {
      return res.status(403).json({
        success: false,
        error: 'You do not own this skin pack'
      });
    }
    
    user.activeSkinPack = packId;
    await user.save();
    
    res.json({
      success: true,
      activePack: packId
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Purchase a skin pack
router.post('/purchase/:packId', authenticateToken, async (req, res) => {
  try {
    const { packId } = req.params;
    const user = await User.findById(req.user.id);
    
    // Get pack info (you'd import this from your skin pack registry)
    const packPrices = {
      'gambino-gold': 0,
      'neon-nights': 1000,
      'luxury-casino': 1500
    };
    
    const price = packPrices[packId];
    if (price === undefined) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }
    
    // Check if already owned
    const alreadyOwned = user.ownedSkinPacks?.some(p => p.packId === packId);
    if (alreadyOwned) {
      return res.status(400).json({ success: false, error: 'Already owned' });
    }
    
    // Check balance
    if (user.gambinoBalance < price) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient GOLD balance' 
      });
    }
    
    // Deduct and grant
    user.gambinoBalance -= price;
    user.ownedSkinPacks.push({
      packId,
      purchasedAt: new Date(),
      purchasePrice: price,
      grantedBy: 'purchase'
    });
    
    await user.save();
    
    res.json({
      success: true,
      newBalance: user.gambinoBalance,
      ownedPacks: user.ownedSkinPacks.map(p => p.packId)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;