// backend/src/routes/onboarding.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const User = require('../models/User');
const WalletService = require('../services/walletService');
const rateLimit = require('express-rate-limit');

const walletService = new WalletService();

// Rate limiting for onboarding
const onboardingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many account creation attempts, please try again later'
});

// Validation schemas
const stepOneSchema = Joi.object({
  firstName: Joi.string().min(2).max(50).required(),
  lastName: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().pattern(/^\+?[\d\s\-\(\)]{10,}$/).optional(),
  dateOfBirth: Joi.date().max('now').optional()
});

const stepTwoSchema = Joi.object({
  storeId: Joi.string().required(),
  agreedToTerms: Joi.boolean().valid(true).required(),
  marketingConsent: Joi.boolean().optional()
});

const stepThreeSchema = Joi.object({
  depositAmount: Joi.number().min(10).max(500).required(),
  paymentMethod: Joi.string().valid('cash', 'card', 'crypto').required()
});

// Step 1: Personal Information
router.post('/step1', onboardingLimiter, async (req, res) => {
  try {
    // Validate input
    const { error, value } = stepOneSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        error: error.details[0].message 
      });
    }

    const { firstName, lastName, email, phone, dateOfBirth } = value;

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ 
        success: false, 
        error: 'An account with this email already exists' 
      });
    }

    // Generate wallet
    const wallet = walletService.generateWallet();
    const encryptedPrivateKey = walletService.encryptPrivateKey(wallet.secretKey);
    
    // Generate recovery phrase
    const recoveryPhrase = walletService.generateRecoveryPhrase();
    const encryptedRecoveryPhrase = walletService.encryptPrivateKey(recoveryPhrase.split(' '));

    // Create user with step 1 data
    const user = new User({
      firstName,
      lastName,
      email: email.toLowerCase(),
      phone,
      dateOfBirth,
      walletAddress: wallet.publicKey,
      encryptedPrivateKey: encryptedPrivateKey.encrypted,
      privateKeyIV: encryptedPrivateKey.iv,
      recoveryPhrase: encryptedRecoveryPhrase.encrypted,
      recoveryPhraseIV: encryptedRecoveryPhrase.iv,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      signupSource: 'web'
    });

    await user.save();

    // Generate temporary token for onboarding process
    const tempToken = jwt.sign(
      { 
        userId: user._id, 
        step: 1,
        onboarding: true 
      },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '1h' }
    );

    console.log(`📝 Step 1 completed for: ${email}`);

    res.status(201).json({
      success: true,
      message: 'Step 1 completed successfully',
      data: {
        userId: user._id,
        walletAddress: user.walletAddress,
        recoveryPhrase: recoveryPhrase, // Send once for user to save
        nextStep: 2
      },
      tempToken
    });

  } catch (error) {
    console.error('❌ Step 1 error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process step 1' 
    });
  }
});

// Step 2: Store Selection
router.post('/step2', async (req, res) => {
  try {
    // Verify temp token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    if (!decoded.onboarding || decoded.step !== 1) {
      return res.status(401).json({ success: false, error: 'Invalid onboarding state' });
    }

    // Validate input
    const { error, value } = stepTwoSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        error: error.details[0].message 
      });
    }

    const { storeId, agreedToTerms, marketingConsent } = value;

    // Update user with step 2 data
    const user = await User.findByIdAndUpdate(
      decoded.userId,
      {
        favoriteLocation: storeId,
        preferences: {
          emailNotifications: true,
          marketingEmails: marketingConsent || false
        },
        lastActivity: new Date()
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Create token account for Gambino tokens
    const tokenAccountResult = await walletService.createTokenAccount(
      { publicKey: user.walletAddress },
      process.env.GAMBINO_MINT_ADDRESS
    );

    if (tokenAccountResult.success) {
      user.tokenAccount = tokenAccountResult.tokenAccount;
      await user.save();
    }

    // Generate new temp token for step 3
    const tempToken = jwt.sign(
      { 
        userId: user._id, 
        step: 2,
        onboarding: true 
      },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '1h' }
    );

    console.log(`🏪 Step 2 completed for user: ${user._id}`);

    res.json({
      success: true,
      message: 'Step 2 completed successfully',
      data: {
        storeId,
        tokenAccount: user.tokenAccount,
        nextStep: 3
      },
      tempToken
    });

  } catch (error) {
    console.error('❌ Step 2 error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process step 2' 
    });
  }
});

// Step 3: Initial Deposit & Account Activation
router.post('/step3', async (req, res) => {
  try {
    // Verify temp token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    if (!decoded.onboarding || decoded.step !== 2) {
      return res.status(401).json({ success: false, error: 'Invalid onboarding state' });
    }

    // Validate input
    const { error, value } = stepThreeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        error: error.details[0].message 
      });
    }

    const { depositAmount, paymentMethod } = value;

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Calculate GAMBINO tokens (mock pricing)
    const currentPrice = 0.001; // $0.001 per GAMBINO
    const tokensToMint = Math.floor(depositAmount / currentPrice);

    // Process payment (mock for now)
    // In production, integrate with payment processor here

    // Update user with initial deposit
    user.gambinoBalance = tokensToMint;
    user.totalDeposited = depositAmount;
    user.isVerified = true; // Basic verification complete
    user.isActive = true;
    user.lastActivity = new Date();
    user.loginCount = 1;

    await user.save();

    // Create transaction record
    const Transaction = require('../models/Transaction');
    const transaction = new Transaction({
      userId: user._id,
      type: 'purchase',
      amount: tokensToMint,
      usdAmount: depositAmount,
      status: 'completed',
      txHash: `onboarding_${Date.now()}_${user._id}`,
      metadata: { 
        paymentMethod, 
        pricePerToken: currentPrice,
        onboardingDeposit: true
      }
    });

    await transaction.save();

    // Generate full access token
    const accessToken = jwt.sign(
      { 
        userId: user._id, 
        walletAddress: user.walletAddress,
        tier: user.tier
      },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    console.log(`🎉 Onboarding completed for: ${user.email} - ${tokensToMint} GAMBINO tokens`);

    res.json({
      success: true,
      message: 'Account created successfully!',
      data: {
        user: user.toSafeObject(),
        tokensReceived: tokensToMint,
        pricePerToken: currentPrice,
        totalPaid: depositAmount,
        transactionId: transaction._id
      },
      accessToken
    });

  } catch (error) {
    console.error('❌ Step 3 error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to complete onboarding' 
    });
  }
});

// Get onboarding progress
router.get('/progress/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let step = 0;
    if (user.firstName && user.lastName && user.email) step = 1;
    if (user.favoriteLocation) step = 2;
    if (user.isVerified && user.gambinoBalance > 0) step = 3;

    res.json({
      success: true,
      progress: {
        currentStep: step,
        totalSteps: 3,
        completed: step === 3,
        data: {
          hasPersonalInfo: !!(user.firstName && user.lastName && user.email),
          hasStoreSelection: !!user.favoriteLocation,
          hasInitialDeposit: user.gambinoBalance > 0,
          isVerified: user.isVerified
        }
      }
    });

  } catch (error) {
    console.error('❌ Progress check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check progress' 
    });
  }
});

// Resend verification email (if needed)
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, error: 'User already verified' });
    }

    // In production, send verification email here
    console.log(`📧 Verification email sent to: ${email}`);

    res.json({
      success: true,
      message: 'Verification email sent'
    });

  } catch (error) {
    console.error('❌ Resend verification error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to resend verification' 
    });
  }
});

module.exports = router;