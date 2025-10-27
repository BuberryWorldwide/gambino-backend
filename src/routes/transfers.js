const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Keypair, Connection, PublicKey, Transaction, sendAndConfirmTransaction, TransactionInstruction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const Transfer = mongoose.model('Transfer');
const router = express.Router();


// Use your existing patterns from server.js
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC, "confirmed");
const GG_TOKEN_MINT = new PublicKey(process.env.GAMBINO_MINT_ADDRESS);
const GG_TOKEN_DECIMALS = parseInt(process.env.GAMBINO_DECIMALS);

// Copy your exact authenticateToken from server.js
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

// Copy your exact decryptPrivateKey from server.js
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

// Reference your existing User model from server.js
const User = mongoose.model('User');



// Add these routes to your transfers.js file

// Get transfer history for authenticated user
router.get('/transfers/history', authenticateToken, async (req, res) => {
  try {
    const transfers = await Transfer.find({ 
      fromUserId: req.user.userId 
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

    res.json({
      success: true,
      transfers: transfers || []
    });
  } catch (error) {
    console.error('Transfer history error:', error);
    res.status(500).json({ error: 'Failed to load transfer history' });
  }
});

// POST /api/wallet/transfer - Send tokens
router.post('/transfer', authenticateToken, async (req, res) => {
  try {
    const { toAddress, amount, memo } = req.body;
    
    if (!toAddress || !amount) {
      return res.status(400).json({ error: 'Recipient address and amount required' });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Validate recipient address format
    let toPublicKey;
    try {
      toPublicKey = new PublicKey(toAddress);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid recipient address format' });
    }

    // Get user with wallet info
    const user = await User.findById(req.user.userId);
    if (!user || !user.walletAddress || !user.privateKey || !user.privateKeyIV) {
      return res.status(400).json({ error: 'No recoverable wallet found' });
    }

    // Decrypt sender's private key
    const privateKeyBase64 = decryptPrivateKey(user.privateKey, user.privateKeyIV);
    const secretKey = Buffer.from(privateKeyBase64, 'base64');
    const fromKeypair = Keypair.fromSecretKey(secretKey);
    const fromPublicKey = fromKeypair.publicKey;

    // Convert amount to token units (assuming 6 decimals for GAMBINO)
    const transferAmount = BigInt(Math.floor(amount * Math.pow(10, GG_TOKEN_DECIMALS)));

    // Get associated token addresses
    const fromTokenAccount = await getAssociatedTokenAddress(
      GG_TOKEN_MINT,
      fromPublicKey
    );

    const toTokenAccount = await getAssociatedTokenAddress(
      GG_TOKEN_MINT,
      toPublicKey
    );

    // Check if sender has sufficient balance
    try {
      const fromBalance = await connection.getTokenAccountBalance(fromTokenAccount);
      const currentBalance = BigInt(fromBalance.value.amount);
      
      if (currentBalance < transferAmount) {
        const humanBalance = Number(currentBalance) / Math.pow(10, GG_TOKEN_DECIMALS);
        return res.status(400).json({ 
          error: `Insufficient balance. You have ${humanBalance.toFixed(2)} GAMBINO` 
        });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Sender does not have a GAMBINO token account' });
    }

    // Check if recipient's token account exists
    let createRecipientATA = false;
    try {
      await connection.getTokenAccountBalance(toTokenAccount);
    } catch (error) {
      // Account doesn't exist, we'll need to create it
      createRecipientATA = true;
    }

    // Build transaction
    const transaction = new Transaction();

    // Add create ATA instruction if recipient doesn't have token account
    if (createRecipientATA) {
      console.log(`Creating ATA for recipient: ${toAddress}`);
      const createATAInstruction = createAssociatedTokenAccountInstruction(
        fromPublicKey, // payer (sender pays for creating recipient's account)
        toTokenAccount, // ATA address
        toPublicKey, // ATA owner
        GG_TOKEN_MINT, // mint
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      transaction.add(createATAInstruction);
    }

    // Add transfer instruction
    const transferInstruction = createTransferInstruction(
      fromTokenAccount, // source
      toTokenAccount, // destination
      fromPublicKey, // source owner
      transferAmount, // amount
      [], // multiSigners
      TOKEN_PROGRAM_ID
    );
    transaction.add(transferInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPublicKey;

    // Send and confirm transaction
    console.log(`Sending ${amount} GAMBINO from ${user.walletAddress} to ${toAddress}...`);
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [fromKeypair],
      {
        commitment: 'confirmed',
        maxRetries: 3,
        skipPreflight: false
      }
    );

    // Save successful transfer to database
    const transfer = await Transfer.create({
      fromUserId: req.user.userId,
      fromAddress: user.walletAddress,
      toAddress,
      amount: parseFloat(amount),
      memo: memo || '',
      txHash: signature,
      status: 'completed',
      networkFee: createRecipientATA ? 0.00203928 : 0.000005 // Estimate
    });

    console.log(`✅ Transfer completed. Signature: ${signature}`);

    res.json({
      success: true,
      message: `Successfully transferred ${amount} GAMBINO`,
      transferId: transfer._id,
      txHash: signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      recipientAccountCreated: createRecipientATA,
      networkFee: transfer.networkFee
    });

  } catch (error) {
    console.error('❌ Transfer error:', error);
    
    // Save failed transfer to database for debugging
    try {
      await Transfer.create({
        fromUserId: req.user.userId,
        fromAddress: req.user.walletAddress || 'unknown',
        toAddress: req.body.toAddress,
        amount: parseFloat(req.body.amount || 0),
        memo: req.body.memo || '',
        txHash: 'failed_' + Date.now(),
        status: 'failed',
        errorMessage: error.message
      });
    } catch (dbError) {
      console.error('Failed to save error transfer:', dbError);
    }

    // Handle specific Solana errors
    if (error.message?.includes('insufficient funds')) {
      return res.status(400).json({ error: 'Insufficient SOL for transaction fees (need ~0.002 SOL)' });
    }
    
    if (error.message?.includes('Invalid public key')) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    if (error.message?.includes('Account not found')) {
      return res.status(400).json({ error: 'Sender token account not found' });
    }

    res.status(500).json({ 
      error: 'Transfer failed', 
      details: process.env.NODE_ENV === 'development' ? error.message : 'Please try again'
    });
  }
});

module.exports = router;