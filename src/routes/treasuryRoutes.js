// Add this to your treasury routes
const BALANCE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_DELAY = 1000; // 1 second between requests

async function shouldRefreshBalance(wallet) {
  if (!wallet.cachedBalances?.lastUpdated) return true;
  
  const age = Date.now() - new Date(wallet.cachedBalances.lastUpdated).getTime();
  return age > BALANCE_CACHE_DURATION;
}

// Updated GET route that serves cached balances
router.get('/', async (req, res) => {
  try {
    console.log('Fetching treasury wallets...');
    
    // Get DB wallets with cached balances
    const dbWallets = await TreasuryWallet.find({})
      .select('-privateKeyEncrypted')
      .sort({ createdAt: -1 });

    // Get env wallets (you could also cache these in a separate collection)
    const envWallets = getEnvWallets(); // Your existing env wallet logic
    
    // Serve cached balances immediately
    const allWallets = [...envWallets, ...dbWallets.map(w => ({
      ...w.toObject(),
      source: 'db',
      balances: w.cachedBalances || { SOL: null, GG: null, USDC: null }
    }))];

    res.json({ 
      success: true, 
      wallets: allWallets,
      count: allWallets.length,
      cacheInfo: {
        lastUpdated: Math.min(...allWallets.map(w => 
          w.balances?.lastUpdated ? new Date(w.balances.lastUpdated).getTime() : 0
        )),
        needsRefresh: allWallets.some(w => shouldRefreshBalance(w))
      }
    });

  } catch (error) {
    console.error('Treasury fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});