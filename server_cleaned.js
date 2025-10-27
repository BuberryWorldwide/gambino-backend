require('dotenv').config({ path: '/opt/gambino/.env' });

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// --- System wallets (single source of truth) ---
const SYSTEM_WALLETS = {
  MAIN_TREASURY: process.env.MAIN_TREASURY_WALLET,
  JACKPOT:       process.env.JACKPOT_WALLET,
  OPERATIONS:    process.env.OPERATIONS_WALLET,
  TEAM:          process.env.TEAM_WALLET,
  COMMUNITY:     process.env.COMMUNITY_WALLET
};

// --- CORS CONFIGURATION ---
const ALLOW = [
  /^https:\/\/.*\.vercel\.app$/,
  'https://app.gambino.gold',
  'http://localhost:3000',
  'https://gambino.gold',
  'http://192.168.1.235:3000',
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOW.some(x => x instanceof RegExp ? x.test(origin) : x === origin);
    cb(ok ? null : new Error('CORS blocked: ' + origin), ok);
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type','X-Requested-With'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// --- Security & parsers ---
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Rate limiting ---
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 300 : 10000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || req.path === '/health',
});
app.use(globalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
  skipSuccessfulRequests: true,
});

// --- UTILITY FUNCTIONS ---
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const TX_DATA_DIR = process.env.TX_DATA_DIR || path.join(process.cwd(), 'gambino_data');
const TX_JSONL_FILE = path.join(TX_DATA_DIR, 'transactions.jsonl');

function encryptPrivateKey(secretKeyBase64) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex'),
    iv
  );
  let encrypted = cipher.update(secretKeyBase64, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return { encrypted, iv: iv.toString('base64') };
}

function decryptPrivateKey(encrypted, ivBase64) {
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex'),
    iv
  );
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function appendJsonl(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

async function readJsonl(file) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    const lines = content
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return lines.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch {
    return [];
  }
}

const maskEmail = email => email ? email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : null;
const maskAddress = addr => addr ? `${addr.slice(0, 2)}…${addr.slice(-3)}` : 'unknown';

const calculateGluckScore = (majorJackpots, minorJackpots, machinesPlayed) => {
  const base = majorJackpots * 1000 + minorJackpots * 100;
  const unique = new Set(machinesPlayed).size;
  const mult = unique >= 7 ? 3 : unique >= 5 ? 2.5 : unique >= 3 ? 2 : unique >= 2 ? 1.5 : 1;
  return Math.floor(base * mult);
};

const determineTier = (majorJackpots, minorJackpots, machinesPlayed) => {
  const unique = new Set(machinesPlayed).size;
  if (majorJackpots >= 7 && unique >= 3) return 'tier1';
  if ((majorJackpots >= 1 && minorJackpots >= 10 && unique >= 2) || majorJackpots >= 2) return 'tier2';
  if (minorJackpots >= 50 || (minorJackpots >= 20 && unique >= 2)) return 'tier3';
  return 'none';
};

// --- DATABASE CONNECTION ---
const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('📦 MongoDB connected');
};

// --- SCHEMAS & MODELS ---
const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: String,
  username: { type: String, unique: true, sparse: true, lowercase: true },
  password: { type: String, required: true, select: false },
  walletAddress: { type: String, sparse: true, default: null },
  privateKey: { type: String, default: null },
  privateKeyIV: { type: String, default: null },
  agreedToTerms: { type: Boolean, default: false },
  agreedToPrivacy: { type: Boolean, default: false },
  marketingConsent: { type: Boolean, default: false },
  agreementTimestamp: { type: Date, default: null },
  readWhitepaper: { type: Boolean, default: false },
  complianceVersion: { type: String, default: '1.0' },
  ipAddress: { type: String },
  role: {
    type: String,
    enum: ['user', 'store_manager', 'store_owner', 'super_admin'],
    default: 'user'
  },
  gambinoBalance: { type: Number, default: 0 },
  gluckScore: { type: Number, default: 0 },
  tier: { type: String, enum: ['none', 'tier3', 'tier2', 'tier1'], default: 'none' },
  totalJackpots: { type: Number, default: 0 },
  majorJackpots: { type: Number, default: 0 },
  minorJackpots: { type: Number, default: 0 },
  machinesPlayed: [String],
  favoriteLocation: String,
  isVerified: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now },
  cachedSolBalance: { type: Number, default: 0 },
  cachedGambinoBalance: { type: Number, default: 0 }, 
  cachedUsdcBalance: { type: Number, default: 0 },
  balanceLastUpdated: { type: Date, default: null },
  balanceSyncAttempts: { type: Number, default: 0 },
  balanceSyncError: { type: String, default: null },
});

userSchema.methods.hasRecoverableWallet = function() {
  return this.walletAddress && this.privateKey && this.privateKeyIV;
};

userSchema.methods.isLegallyCompliant = function() {
  return this.agreedToTerms && this.agreedToPrivacy && this.agreementTimestamp;
};

userSchema.methods.updateLegalAgreements = function(agreements) {
  this.agreedToTerms = agreements.agreedToTerms;
  this.agreedToPrivacy = agreements.agreedToPrivacy;
  this.marketingConsent = agreements.marketingConsent || false;
  this.readWhitepaper = agreements.readWhitepaper || false;
  this.agreementTimestamp = new Date();
  this.complianceVersion = '1.0';
};

userSchema.index({ email: 1 });
userSchema.index({ username: 1 }, { sparse: true });
userSchema.index({ walletAddress: 1 });
userSchema.index({ gluckScore: -1 });
userSchema.index({ cachedGambinoBalance: -1 });
userSchema.index({ balanceLastUpdated: 1, walletAddress: 1 });

const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['purchase', 'jackpot', 'burn', 'tier_reward'], required: true },
  amount: { type: Number, required: true },
  usdAmount: Number,
  machineId: String,
  txHash: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  gluckScoreChange: { type: Number, default: 0 },
  metadata: Object,
  createdAt: { type: Date, default: Date.now }
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ type: 1 });
const Transaction = mongoose.model('Transaction', transactionSchema);

const StoreSchema = new mongoose.Schema({
  storeId: { type: String, unique: true, sparse: true },
  storeName: String,
  name: String,
  address: String,
  city: String,
  state: String,
  zipCode: String,
  phone: String,
  feePercentage: { type: Number, default: 5, min: 0, max: 100 },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  walletAddress: { type: String, sparse: true },
  machineCount: { type: Number, default: 8 },
  status: { type: String, enum: ['active','inactive','suspended'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'stores' });

const Store = mongoose.model('Store', StoreSchema);

const machineSchema = new mongoose.Schema({
  machineId: { type: String, required: true, unique: true },
  storeId: { type: String, required: true },
  name: { type: String }, // Optional display name
  status: { type: String, enum: ['active', 'inactive', 'maintenance'], default: 'active' },
  location: String, // Physical location within store
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

machineSchema.index({ machineId: 1 });
machineSchema.index({ storeId: 1 });
const Machine = mongoose.model('Machine', machineSchema);

const treasuryWalletSchema = new mongoose.Schema({
  label: { type: String, required: true },
  purpose: { type: String, enum: ['main','jackpot','ops','team','community','store_float','other'], default: 'other' },
  publicKey: { type: String, required: true, unique: true },
  privateKey: { type: String, required: true },
  privateKeyIV: { type: String, required: true },
  source: { type: String, default: 'db' },
  cachedBalances: {
    SOL: { type: Number, default: null },
    GG: { type: Number, default: null },
    USDC: { type: Number, default: null }
  },
  lastBalanceUpdate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const TreasuryWallet = mongoose.model('TreasuryWallet', treasuryWalletSchema);

// --- BALANCE SYNC SERVICE (SIMPLIFIED) ---
class BalanceSyncService {
  constructor(connection, tokenMints) {
    this.connection = connection;
    this.tokenMints = tokenMints;
    this.isRunning = false;
    this.rateLimitDelay = 1000;
    this.maxRetries = 3;
    this.batchSize = 10;
  }

  async syncUserBalance(userId, retryCount = 0) {
    // Simplified version - implement as needed
    return { success: true, userId };
  }

  async batchSync(userIds = null, maxUsers = 20) {
    if (this.isRunning) return { success: false, message: 'Sync already in progress' };
    this.isRunning = true;
    
    try {
      // Simplified implementation
      return { success: true, totalProcessed: 0, successCount: 0, errorCount: 0 };
    } finally {
      this.isRunning = false;
    }
  }
}

// --- AUTHENTICATION MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      req.user = {
        userId: decoded.userId,
        walletAddress: decoded.walletAddress,
        email: decoded.email,
        tier: decoded.tier,
        role: decoded.role || 'user' 
      };

      return next();
    });
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

function authenticateAdmin(req, res, next) {
  const hdrAuth = req.get('authorization') || '';
  const apiKey = req.get('x-api-key') || '';
  const jwtSecret = process.env.JWT_SECRET;
  const configuredKey = process.env.ADMIN_API_KEY || process.env.ADMIN_KEY || '';

  const [, bearerToken] = hdrAuth.split(' ');
  if (configuredKey && (apiKey === configuredKey || bearerToken === configuredKey || hdrAuth === configuredKey)) {
    req.admin = { method: 'apiKey', role: 'super_admin' };
    return next();
  }

  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, jwtSecret, { algorithms: ['HS256'] });
      const allowed = new Set(['store_manager', 'store_owner', 'super_admin', 'admin']);
      if (!decoded?.role || !allowed.has(decoded.role)) {
        return res.status(403).json({ error: 'Admin role required' });
      }
      req.admin = { ...decoded, method: 'jwt' };
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// --- SOLANA CONNECTION ---
const { Keypair, Connection, PublicKey } = require('@solana/web3.js');
const QRCode = require('qrcode');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC, "confirmed");

const TOKEN_MINTS = {
  GG: "Cd2wZyKVdWuyuJJHmeU1WmfSKNnDHku2m6mt6XFqGeXn", 
  USDC: "Es9vMFrzaCERZ8YvKjWJ6dD3pDPnbuzcFh3RDFw4YcGJ"
};

const balanceSyncService = new BalanceSyncService(connection, TOKEN_MINTS);

// --- TEMPORARY SESSION STORAGE ---
const temporaryUsers = new Map();

// --- HELPER FUNCTIONS ---
function envTreasuryList() {
  const map = [
    ['MAIN_TREASURY','main'],
    ['JACKPOT','jackpot'],
    ['OPERATIONS','ops'],
    ['TEAM','team'],
    ['COMMUNITY','community']
  ];
  const out = [];
  for (const [key, purpose] of map) {
    const pk = SYSTEM_WALLETS[key];
    if (pk) out.push({ label: key.toLowerCase(), purpose, publicKey: pk, source: 'env', createdAt: null });
  }
  return out;
}

// ===== ROUTES =====

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// USER REGISTRATION & AUTH
app.post('/api/users/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body;

    if (!firstName || !lastName) return res.status(400).json({ error: 'First/last name required' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password ≥ 6 chars' });

    const existing = await User.findOne({ email: email.toLowerCase() }).lean();
    if (existing) return res.status(409).json({ error: 'Account already exists' });

    const passwordHashed = await bcrypt.hash(password, 12);

    const user = await User.create({
      firstName,
      lastName,
      email: email.toLowerCase(),
      phone,
      password: passwordHashed,
      gambinoBalance: 0,
      gluckScore: 0,
      tier: 'none',
      isVerified: true,
      isActive: true
    });

    const accessToken = jwt.sign(
      { userId: user._id, walletAddress: user.walletAddress, tier: user.tier, email: user.email },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      success: true,
      message: 'Account created',
      user: {
        id: user._id,
        email: user.email,
        walletAddress: user.walletAddress,
        gambinoBalance: user.gambinoBalance,
        gluckScore: user.gluckScore,
        tier: user.tier,
        createdAt: user.createdAt
      },
      accessToken
    });
  } catch (err) {
    console.error('❌ /api/users/register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/users/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    user.lastActivity = new Date();
    await user.save();

    const token = jwt.sign(
      {
        userId: user._id,
        walletAddress: user.walletAddress || null,
        role: user.role || 'user',
        email: user.email
      },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        walletAddress: user.walletAddress || null,
        gambinoBalance: user.gambinoBalance,
        gluckScore: user.gluckScore,
        tier: user.tier,
        role: user.role || 'user'
      },
      token
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const normalizedEmail = String(email).toLowerCase();

    const user = await User.findOne({ email: normalizedEmail })
      .select('+password role firstName lastName isActive');

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.password) {
      return res.status(500).json({ error: 'Account has no password set' });
    }
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account inactive' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ADMIN_ROLES = ['store_manager', 'store_owner', 'super_admin'];
    if (!ADMIN_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Access denied - insufficient permissions' });
    }

    const adminToken = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      message: 'Admin login successful',
      token: adminToken,
      admin: {
        id: user._id,
        email: user.email,
        role: user.role,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim()
      }
    });
  } catch (error) {
    console.error('❌ Admin login error (catch):', error);
    return res.status(500).json({ error: 'Admin login failed' });
  }
});

// USER PROFILE
app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.json({
      success: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        email: user.email,
        walletAddress: user.walletAddress || null,
        gambinoBalance: user.gambinoBalance,
        gluckScore: user.gluckScore,
        tier: user.tier,
        role: user.role || 'user',
        totalJackpots: user.totalJackpots,
        majorJackpots: user.majorJackpots,
        minorJackpots: user.minorJackpots,
        machinesPlayed: user.machinesPlayed,
        createdAt: user.createdAt,
        lastActivity: user.lastActivity
      }
    });
  } catch (error) {
    console.error('❌ Profile fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone, email } = req.body;
    const userId = req.user.userId;

    if (firstName && firstName.trim().length === 0) {
      return res.status(400).json({ error: 'First name cannot be empty' });
    }
    if (lastName && lastName.trim().length === 0) {
      return res.status(400).json({ error: 'Last name cannot be empty' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      user.email = email.toLowerCase();
    }

    if (firstName !== undefined) user.firstName = firstName.trim();
    if (lastName !== undefined) user.lastName = lastName.trim();
    if (phone !== undefined) user.phone = phone;
    
    user.lastActivity = new Date();
    await user.save();
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone
      }
    });
    
  } catch (error) {
    console.error('❌ Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.post('/api/users/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.userId).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password) {
      return res.status(400).json({ error: 'Password not set for this account' });
    }

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = await bcrypt.hash(newPassword, 12);
    user.lastActivity = new Date();
    await user.save();

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('❌ Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// WALLET OPERATIONS
app.post('/api/wallet/generate', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.walletAddress) {
      return res.status(400).json({ error: "Wallet already exists for this user" });
    }

    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');

    const { encrypted, iv } = encryptPrivateKey(privateKeyBase64);

    user.walletAddress = publicKey;
    user.privateKey = encrypted;
    user.privateKeyIV = iv;
    await user.save();

    return res.json({
      success: true,
      walletAddress: publicKey,
      hasRecoverableKey: true,
      note: "Wallet ready for use"
    });
  } catch (err) {
    console.error("Wallet generation error:", err);
    return res.status(500).json({ error: "Failed to generate wallet" });
  }
});

app.get('/api/wallet/balance/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const pubKey = new PublicKey(walletAddress);

    const solBalance = await connection.getBalance(pubKey);

    const tokenBalances = {};
    for (const [symbol, mint] of Object.entries(TOKEN_MINTS)) {
      try {
        const accounts = await connection.getParsedTokenAccountsByOwner(pubKey, {
          mint: new PublicKey(mint)
        });

        if (accounts.value.length > 0) {
          tokenBalances[symbol] =
            accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        } else {
          tokenBalances[symbol] = 0;
        }
      } catch (err) {
        tokenBalances[symbol] = null;
      }
    }

    res.json({
      success: true,
      balances: {
        SOL: solBalance / 1e9,
        ...tokenBalances
      }
    });
  } catch (error) {
    console.error("❌ Balance fetch error:", error);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

app.get('/api/wallet/qrcode/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const qr = await QRCode.toDataURL(walletAddress);
    res.json({ success: true, walletAddress, qr });
  } catch (error) {
    console.error("❌ QR code error:", error);
    res.status(500).json({ error: "Failed to generate QR code" });
  }
});

app.get('/api/wallet/private-key', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || !user.privateKey || !user.privateKeyIV) {
      return res.status(404).json({ error: 'No recoverable key on file' });
    }
    const privateKeyBase64 = decryptPrivateKey(user.privateKey, user.privateKeyIV);
    return res.json({ success: true, privateKey: privateKeyBase64 });
  } catch (e) {
    console.error('private-key error:', e);
    res.status(500).json({ error: 'Failed to retrieve private key' });
  }
});

app.post('/api/wallet/connect', authenticateToken, async (req, res) => {
  try {
    const { publicKey, message, signatureBase64 } = req.body || {};
    if (!publicKey || !message || !signatureBase64) {
      return res.status(400).json({ error: 'publicKey, message, and signatureBase64 are required' });
    }

    let pubKeyBytes, sigBytes, msgBytes;
    try {
      pubKeyBytes = bs58.decode(publicKey);
      sigBytes = Buffer.from(signatureBase64, 'base64');
      msgBytes = new TextEncoder().encode(message);
    } catch {
      return res.status(400).json({ error: 'Invalid encoding in inputs' });
    }

    const ok = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
    if (!ok) return res.status(401).json({ error: 'Signature verification failed' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.walletAddress) {
      return res.status(409).json({ error: 'Wallet already set for this account' });
    }

    const taken = await User.findOne({ walletAddress: publicKey });
    if (taken) return res.status(409).json({ error: 'That wallet is already linked to another account' });

    user.walletAddress = publicKey;
    user.privateKey = null;
    user.privateKeyIV = null;
    user.lastActivity = new Date();
    await user.save();

    return res.json({ success: true, walletAddress: publicKey });
  } catch (e) {
    console.error('❌ /api/wallet/connect error:', e);
    return res.status(500).json({ error: 'Failed to link wallet' });
  }
});

// ADMIN STORE MANAGEMENT
app.get('/api/admin/stores', authenticateAdmin, async (req, res) => {
  try {
    const { q } = req.query;
    const where = {};
    if (q) {
      where.$or = [
        { storeId: new RegExp(q, 'i') },
        { storeName: new RegExp(q, 'i') },
        { city: new RegExp(q, 'i') },
        { state: new RegExp(q, 'i') },
      ];
    }
    const stores = await Store.find(where).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ success: true, stores, count: stores.length });
  } catch (e) {
    console.error('admin stores list error:', e);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

app.get('/api/admin/stores/:storeId', authenticateAdmin, async (req, res) => {
  try {
    const s = await Store.findOne({ storeId: req.params.storeId }).lean();
    if (!s) return res.status(404).json({ error: 'Store not found' });
    res.json({ success: true, store: s });
  } catch (e) {
    console.error('admin store get error:', e);
    res.status(500).json({ error: 'Failed to load store' });
  }
});

app.put('/api/admin/stores/:storeId', authenticateAdmin, async (req, res) => {
  try {
    const allowed = [
      'storeName','city','state','address','zipCode','phone',
      'feePercentage','status','ownerUserId'
    ];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

    if ('feePercentage' in patch) patch.feePercentage = Math.max(0, Math.min(100, Number(patch.feePercentage) || 0));
    if ('status' in patch && !['active','inactive','suspended'].includes(patch.status)) delete patch.status;
    patch.updatedAt = new Date();

    const s = await Store.findOneAndUpdate({ storeId: req.params.storeId }, patch, { new: true });
    if (!s) return res.status(404).json({ error: 'Store not found' });
    res.json({ success: true, store: s });
  } catch (e) {
    console.error('admin store update error:', e);
    res.status(500).json({ error: 'Failed to update store' });
  }
});

app.post('/api/admin/stores/create', authenticateAdmin, async (req, res) => {
  try {
    const role = req.admin.role;
    if (!['super_admin','store_owner'].includes(role)) {
      return res.status(403).json({ error: 'Only store_owner/super_admin can create stores' });
    }

    const { storeId, storeName, city, state, address='', zipCode='', phone='', feePercentage=5 } = req.body || {};
    if (!storeId || !storeName || !city || !state) {
      return res.status(400).json({ error: 'storeId, storeName, city, state required' });
    }

    const exists = await Store.findOne({ storeId });
    if (exists) return res.status(409).json({ error: 'storeId already exists' });

    const doc = await Store.create({
      storeId, 
      storeName, 
      city, 
      state, 
      address, 
      zipCode, 
      phone,
      feePercentage: Number(feePercentage) || 0,
      status: 'active', 
      createdAt: new Date()
    });

    res.status(201).json({ success: true, store: doc });
  } catch (e) {
    console.error('admin store create error:', e);
    res.status(500).json({ error: 'Failed to create store' });
  }
});

// STORE WALLET MANAGEMENT
app.get('/api/admin/wallet/:storeId', authenticateAdmin, async (req, res) => {
  try {
    const store = await Store.findOne({ storeId: req.params.storeId }).lean();
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const publicKey = store.walletAddress || null;
    let balances = null;

    if (publicKey) {
      const pubKey = new PublicKey(publicKey);
      const sol = await connection.getBalance(pubKey);
      const out = { SOL: sol / 1e9 };
      for (const [symbol, mint] of Object.entries(TOKEN_MINTS)) {
        try {
          const accs = await connection.getParsedTokenAccountsByOwner(pubKey, { mint: new PublicKey(mint) });
          out[symbol] = accs.value.length ? accs.value[0].account.data.parsed.info.tokenAmount.uiAmount : 0;
        } catch { out[symbol] = null; }
      }
      balances = out;
    }

    res.json({ success: true, wallet: { publicKey, balances } });
  } catch (e) {
    console.error('wallet get error:', e);
    res.status(500).json({ error: 'Failed to load wallet' });
  }
});

app.post('/api/admin/wallet/:storeId/generate', authenticateAdmin, async (req, res) => {
  try {
    if (!['store_owner','super_admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Only owners or super admins can generate store wallets' });
    }

    const store = await Store.findOne({ storeId: req.params.storeId });
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.walletAddress) return res.status(409).json({ error: 'Wallet already exists' });

    const kp = Keypair.generate();
    const publicKey = kp.publicKey.toBase58();

    store.walletAddress = publicKey;
    await store.save();

    res.json({ success: true, wallet: { publicKey } });
  } catch (e) {
    console.error('wallet generate error:', e);
    res.status(500).json({ error: 'Failed to generate wallet' });
  }
});

// MACHINE MANAGEMENT
app.get('/api/admin/machines', authenticateAdmin, async (req, res) => {
  try {
    const { storeId } = req.query;
    const where = {};
    if (storeId) where.storeId = storeId;

    const machines = await Machine.find(where)
      .sort({ updatedAt: -1 })
      .limit(2000)
      .lean()
      .catch(() => []);

    res.json({ success: true, machines });
  } catch (e) {
    console.error('admin machines list error:', e);
    res.status(500).json({ error: 'Failed to load machines' });
  }
});

app.post('/api/admin/machines/create', authenticateAdmin, async (req, res) => {
  try {
    const { machineId, storeId, name, location } = req.body;

    if (!machineId || !storeId) {
      return res.status(400).json({ error: 'machineId and storeId are required' });
    }

    // Check if store exists
    const store = await Store.findOne({ storeId });
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Check if machine already exists
    const existing = await Machine.findOne({ machineId });
    if (existing) {
      return res.status(409).json({ error: 'Machine ID already exists' });
    }

    const machine = await Machine.create({
      machineId,
      storeId,
      name: name || `Machine ${machineId}`,
      location: location || '',
      status: 'active'
    });

    res.status(201).json({ success: true, machine });
  } catch (e) {
    console.error('machine create error:', e);
    res.status(500).json({ error: 'Failed to create machine' });
  }
});

app.put('/api/admin/machines/:id', authenticateAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body.status) patch.status = req.body.status;
    if (req.body.storeId) patch.storeId = req.body.storeId;
    if (req.body.name) patch.name = req.body.name;
    if (req.body.location) patch.location = req.body.location;
    patch.updatedAt = new Date();

    const m = await Machine.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!m) return res.status(404).json({ error: 'Machine not found' });
    res.json({ success: true, machine: m });
  } catch (e) {
    console.error('admin machine update error:', e);
    res.status(500).json({ error: 'Failed to update machine' });
  }
});

// ADMIN USER MANAGEMENT
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { q, role, active } = req.query;
    const where = {};
    if (q) {
      where.$or = [
        { email: new RegExp(q, 'i') },
        { firstName: new RegExp(q, 'i') },
        { lastName: new RegExp(q, 'i') },
      ];
    }
    if (role) where.role = role;
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;

    const users = await User.find(where)
      .sort({ createdAt: -1 })
      .select('firstName lastName email walletAddress role isActive createdAt')
      .limit(1000)
      .lean();

    res.json({ users, count: users.length });
  } catch (e) {
    console.error('admin users list error:', e);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// BASIC LEADERBOARD (SIMPLIFIED)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

    const topUsers = await User.find({ 
      isActive: { $ne: false },
      gambinoBalance: { $gt: 0 }
    })
    .sort({ gambinoBalance: -1 })
    .limit(limit)
    .select('firstName lastName email gambinoBalance totalJackpots majorJackpots minorJackpots createdAt')
    .lean();

    const leaderboard = topUsers.map((user, index) => ({
      rank: index + 1,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Anonymous Player',
      email: user.email ? user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : 'N/A',
      balance: user.gambinoBalance || 0,
      totalJackpots: user.totalJackpots || 0,
      majorJackpots: user.majorJackpots || 0,
      minorJackpots: user.minorJackpots || 0,
      memberSince: user.createdAt
    }));

    const totalCirculating = leaderboard.reduce((sum, user) => sum + user.balance, 0);
    
    res.json({
      success: true,
      leaderboard,
      stats: {
        totalPlayers: leaderboard.length,
        totalCirculating,
        lastUpdated: new Date(),
        dataSource: 'database'
      }
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🎰 Gambino Backend running on port ${PORT}`);
      console.log(`🔗 Health: http://localhost:${PORT}/health`);
    });
  } catch (e) {
    console.error('❌ Failed to start server:', e);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM: closing DB');
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
