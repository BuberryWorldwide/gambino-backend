// routes/admin/treasury.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Treasury Wallet Schema (if using MongoDB/Mongoose)
const TreasuryWallet = require('../../models/TreasuryWallet'); // You'll need to create this model

// Encryption helpers
const ENCRYPTION_KEY = process.env.TREASURY_ENCRYPTION_KEY || 'your-32-character-secret-key-here!!'; // 32 characters
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = textParts.join(':');
  const decipher = crypto.createDecipher(ALGORITHM, ENCRYPTION_KEY);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Helper function to convert array private key to public key
function getPublicKeyFromPrivateArray(privateKeyArray) {
  const { Keypair } = require('@solana/web3.js');
  try {
    const uint8Array = new Uint8Array(privateKeyArray);
    const keypair = Keypair.fromSecretKey(uint8Array);
    return keypair.publicKey.toBase58();
  } catch (error) {
    console.error('Error deriving public key:', error);
    return null;
  }
}

// GET /api/admin/treasury - List all treasury wallets
router.get('/', async (req, res) => {
  try {
    console.log('📊 Fetching treasury wallets...');
    
    // Get from database
    const dbWallets = await TreasuryWallet.find({})
      .select('-privateKeyEncrypted')
      .sort({ createdAt: -1 });

    // Get from environment variables
    const envWallets = [];
    
    // Main Treasury
    if (process.env.MAIN_TREASURY_PRIVATE_KEY) {
      try {
        const privateKeyArray = JSON.parse(process.env.MAIN_TREASURY_PRIVATE_KEY);
        const publicKey = getPublicKeyFromPrivateArray(privateKeyArray);
        if (publicKey) {
          envWallets.push({
            label: 'Main Treasury (ENV)',
            purpose: 'main',
            publicKey: publicKey,
            source: 'env',
            balances: { SOL: null, GG: null, USDC: null }
          });
        }
      } catch (e) {
        console.error('Failed to parse MAIN_TREASURY_PRIVATE_KEY:', e);
      }
    }

    // Payer wallet
    if (process.env.PAYER_PRIVATE_KEY) {
      try {
        const privateKeyArray = JSON.parse(process.env.PAYER_PRIVATE_KEY);
        const publicKey = getPublicKeyFromPrivateArray(privateKeyArray);
        if (publicKey) {
          envWallets.push({
            label: 'Payer Wallet (ENV)',
            purpose: 'ops',
            publicKey: publicKey,
            source: 'env',
            balances: { SOL: null, GG: null, USDC: null }
          });
        }
      } catch (e) {
        console.error('Failed to parse PAYER_PRIVATE_KEY:', e);
      }
    }

    // Other destination wallets (public only)
    const destinationWallets = [
      { key: 'JACKPOT_WALLET', label: 'Jackpot Pool', purpose: 'jackpot' },
      { key: 'OPERATIONS_WALLET', label: 'Operations', purpose: 'ops' },
      { key: 'TEAM_WALLET', label: 'Team', purpose: 'team' },
      { key: 'COMMUNITY_WALLET', label: 'Community', purpose: 'community' }
    ];

    for (const wallet of destinationWallets) {
      if (process.env[wallet.key]) {
        envWallets.push({
          label: `${wallet.label} (ENV)`,
          purpose: wallet.purpose,
          publicKey: process.env[wallet.key],
          source: 'env',
          balances: { SOL: null, GG: null, USDC: null }
        });
      }
    }

    const allWallets = [...envWallets, ...dbWallets.map(w => ({
      ...w.toObject(),
      source: 'db'
    }))];

    console.log(`✅ Found ${allWallets.length} treasury wallets (${envWallets.length} from env, ${dbWallets.length} from db)`);
    
    res.json({ 
      success: true, 
      wallets: allWallets,
      count: allWallets.length 
    });

  } catch (error) {
    console.error('❌ Treasury fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// POST /api/admin/treasury - Add new treasury wallet
router.post('/', async (req, res) => {
  try {
    const { label, purpose, publicKey, privateKeyBase64 } = req.body;

    console.log('➕ Adding treasury wallet:', { label, purpose, publicKey: publicKey?.substring(0, 8) + '...' });

    // Validation
    if (!label || !purpose || !publicKey || !privateKeyBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: label, purpose, publicKey, privateKeyBase64'
      });
    }

    // Check if wallet already exists
    const existing = await TreasuryWallet.findOne({ publicKey });
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Wallet with this public key already exists'
      });
    }

    // Encrypt private key
    const encryptedPrivateKey = encrypt(privateKeyBase64);

    // Create wallet
    const wallet = new TreasuryWallet({
      label: label.trim(),
      purpose: purpose.toLowerCase(),
      publicKey: publicKey.trim(),
      privateKeyEncrypted: encryptedPrivateKey,
      balances: {
        SOL: null,
        GG: null,
        USDC: null,
        lastUpdated: null
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await wallet.save();

    console.log('✅ Treasury wallet added successfully');

    // Return wallet without private key
    const { privateKeyEncrypted, ...safeWallet } = wallet.toObject();
    res.json({ 
      success: true, 
      wallet: safeWallet 
    });

  } catch (error) {
    console.error('❌ Add wallet error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// POST /api/admin/treasury/refresh-balances
router.post('/refresh-balances', async (req, res) => {
  try {
    console.log('🔄 Refreshing treasury balances...');
    const { Connection, PublicKey } = require('@solana/web3.js');
    
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", 
      "confirmed"
    );

    // Get all wallets (both env and db)
    const envPublicKeys = [];
    
    // Extract public keys from environment
    if (process.env.MAIN_TREASURY_PRIVATE_KEY) {
      try {
        const privateKeyArray = JSON.parse(process.env.MAIN_TREASURY_PRIVATE_KEY);
        const publicKey = getPublicKeyFromPrivateArray(privateKeyArray);
        if (publicKey) envPublicKeys.push(publicKey);
      } catch (e) { /* ignore */ }
    }

    if (process.env.PAYER_PRIVATE_KEY) {
      try {
        const privateKeyArray = JSON.parse(process.env.PAYER_PRIVATE_KEY);
        const publicKey = getPublicKeyFromPrivateArray(privateKeyArray);
        if (publicKey) envPublicKeys.push(publicKey);
      } catch (e) { /* ignore */ }
    }

    // Add destination wallet public keys
    const destKeys = ['JACKPOT_WALLET', 'OPERATIONS_WALLET', 'TEAM_WALLET', 'COMMUNITY_WALLET'];
    for (const key of destKeys) {
      if (process.env[key]) envPublicKeys.push(process.env[key]);
    }

    const dbWallets = await TreasuryWallet.find({});
    const results = [];

    // Refresh environment wallet balances
    for (const publicKey of envPublicKeys) {
      try {
        const pubKey = new PublicKey(publicKey);
        const solBalance = await connection.getBalance(pubKey);
        
        // You can add token balance fetching here if needed
        
        results.push({
          publicKey,
          success: true,
          balances: {
            SOL: solBalance / 1e9,
            GG: 0, // Add actual token balance fetching
            USDC: 0
          }
        });
      } catch (error) {
        results.push({
          publicKey,
          success: false,
          error: error.message
        });
      }
    }

    // Refresh database wallet balances
    for (const wallet of dbWallets) {
      try {
        const pubKey = new PublicKey(wallet.publicKey);
        const solBalance = await connection.getBalance(pubKey);
        
        wallet.balances = {
          SOL: solBalance / 1e9,
          GG: 0, // Add actual token balance fetching
          USDC: 0,
          lastUpdated: new Date()
        };
        
        await wallet.save();
        
        results.push({
          publicKey: wallet.publicKey,
          success: true,
          balances: wallet.balances
        });
      } catch (error) {
        results.push({
          publicKey: wallet.publicKey,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Refreshed balances for ${results.filter(r => r.success).length}/${results.length} wallets`,
      results
    });

  } catch (error) {
    console.error('❌ Refresh balances error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// POST /api/admin/treasury/:id/rotate - Rotate private key
router.post('/:id/rotate', async (req, res) => {
  try {
    const { id } = req.params;
    const { privateKeyBase64 } = req.body;

    console.log('🔄 Rotating key for wallet:', id);

    if (!privateKeyBase64) {
      return res.status(400).json({
        success: false,
        error: 'privateKeyBase64 is required'
      });
    }

    const wallet = await TreasuryWallet.findById(id);
    if (!wallet) {
      return res.status(404).json({
        success: false,
        error: 'Wallet not found'
      });
    }

    // Encrypt new private key
    wallet.privateKeyEncrypted = encrypt(privateKeyBase64);
    wallet.updatedAt = new Date();
    
    await wallet.save();

    console.log('✅ Private key rotated successfully');

    res.json({ 
      success: true, 
      message: 'Private key rotated successfully' 
    });

  } catch (error) {
    console.error('❌ Key rotation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;