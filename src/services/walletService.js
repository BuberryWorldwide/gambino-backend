// backend/src/services/walletService.js
const { Keypair, PublicKey, Connection, clusterApiUrl } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

class WalletService {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'),
      'confirmed'
    );
    this.encryptionKey = process.env.WALLET_ENCRYPTION_KEY || 'default-key-change-this';
  }

  // Generate a new Solana wallet
  generateWallet() {
    const keypair = Keypair.generate();
    return {
      publicKey: keypair.publicKey.toString(),
      secretKey: Array.from(keypair.secretKey),
      keypair: keypair
    };
  }

  // Encrypt private key for secure storage
  encryptPrivateKey(secretKey) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipher(algorithm, key);
    let encrypted = cipher.update(JSON.stringify(secretKey), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted: encrypted,
      iv: iv.toString('hex')
    };
  }

  // Decrypt private key for use
  decryptPrivateKey(encryptedData, iv) {
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    
    const decipher = crypto.createDecipher(algorithm, key);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }

  // Create Gambino token account for user
  async createTokenAccount(userWallet, gambinoMintAddress) {
    try {
      const userPublicKey = new PublicKey(userWallet.publicKey);
      const mintPublicKey = new PublicKey(gambinoMintAddress);
      
      // In production, you'd create this on-chain
      // For now, return a mock token account address
      const tokenAccount = Keypair.generate().publicKey.toString();
      
      return {
        success: true,
        tokenAccount: tokenAccount,
        mint: gambinoMintAddress,
        owner: userWallet.publicKey
      };
    } catch (error) {
      console.error('Token account creation error:', error);
      return { success: false, error: error.message };
    }
  }

  // Generate wallet recovery phrase
  generateRecoveryPhrase() {
    // Simple implementation - in production use BIP39
    const words = [
      'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
      'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
      'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual'
    ];
    
    const phrase = [];
    for (let i = 0; i < 12; i++) {
      phrase.push(words[Math.floor(Math.random() * words.length)]);
    }
    
    return phrase.join(' ');
  }

  // Validate wallet address
  isValidSolanaAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  // Get wallet balance
  async getWalletBalance(publicKey) {
    try {
      const balance = await this.connection.getBalance(new PublicKey(publicKey));
      return {
        success: true,
        balance: balance / 1e9, // Convert lamports to SOL
        balanceLamports: balance
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Mock function to check Gambino token balance
  async getGambinoBalance(walletAddress, tokenAccount) {
    // In production, query actual token account
    // For now, return mock data
    return {
      success: true,
      balance: 0,
      tokenAccount: tokenAccount,
      mint: process.env.GAMBINO_MINT_ADDRESS || 'GambinoMintAddress123...'
    };
  }
}

module.exports = WalletService;