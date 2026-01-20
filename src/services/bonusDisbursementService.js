/**
 * Bonus Disbursement Service
 * 
 * Handles automatic token distribution for:
 * - Signup bonuses (email verified + terms accepted)
 * - KYC bonuses (venue verification)
 * 
 * Uses DistributionService for actual Solana token transfers
 * from the community wallet.
 */

const DistributionService = require('./distributionService');
const SignupBonus = require('../models/SignupBonus');
const VenueKycReward = require('../models/VenueKycReward');
// Get User model lazily to avoid circular dependency
function getUser() {
  return require('mongoose').model('User');
}

// Configuration
const CONFIG = {
  SIGNUP_BONUS_AMOUNT: parseInt(process.env.SIGNUP_BONUS_AMOUNT || '25'),
  REFERRER_BONUS_AMOUNT: parseInt(process.env.REFERRER_BONUS_AMOUNT || '25'),
  KYC_BONUS_AMOUNT: parseInt(process.env.KYC_BONUS_AMOUNT || '25'),
  SOURCE_ACCOUNT: 'community',  // Use community treasury for all bonuses
  MAX_RETRIES: 3
};

class BonusDisbursementService {
  constructor() {
    this.distributionService = new DistributionService();
  }

  /**
   * Disburse signup bonus to a user
   * Called when: email verified + terms accepted
   * 
   * @param {Object} params
   * @param {string} params.userId - MongoDB user ID
   * @param {string} params.walletAddress - Solana wallet address
   * @param {string} params.email - User email (for logging)
   * @param {Object} params.referralInfo - Optional referral info
   * @returns {Object} Result with success status and tx signature
   */
  async disburseSignupBonus({ userId, walletAddress, email, referralInfo = {} }) {
    console.log(`🎁 Processing signup bonus for user ${userId}`);

    // Wallet validation - user must have created/connected a wallet first
    if (!walletAddress || walletAddress.length < 32) {
      console.log(`⏳ Signup bonus deferred for user ${userId} - no wallet connected yet`);
      return {
        success: false,
        reason: 'no_wallet',
        message: 'User has not created or connected a wallet yet'
      };
    }

    // Idempotency check - has this user already received signup bonus?
    const existing = await SignupBonus.findOne({ userId });
    if (existing) {
      if (existing.status === 'distributed') {
        console.log(`⚠️ Signup bonus already distributed to user ${userId}`);
        return {
          success: false,
          reason: 'already_distributed',
          txSignature: existing.txSignature
        };
      }
      // If pending/failed, we'll retry
      if (existing.status === 'processing') {
        console.log(`⚠️ Signup bonus already processing for user ${userId}`);
        return {
          success: false,
          reason: 'already_processing'
        };
      }
    }

    // Create or update signup bonus record
    let signupBonus = existing || new SignupBonus({
      userId,
      userEmail: email,
      walletAddress,
      amount: CONFIG.SIGNUP_BONUS_AMOUNT,
      trigger: 'email_verified',
      referredBy: referralInfo.referrerId,
      referralCode: referralInfo.referralCode
    });

    signupBonus.status = 'processing';
    signupBonus.retryCount = (signupBonus.retryCount || 0) + 1;
    await signupBonus.save();

    try {
      // Execute actual Solana token transfer
      const result = await this.distributionService.distributeTokens({
        venueId: 'signup_bonus',
        venueName: 'Signup Bonus System',
        recipient: walletAddress,
        amount: CONFIG.SIGNUP_BONUS_AMOUNT,
        sourceAccount: CONFIG.SOURCE_ACCOUNT,
        metadata: {
          type: 'signup_bonus',
          userId: userId.toString(),
          email
        }
      });

      if (result.success) {
        signupBonus.status = 'distributed';
        signupBonus.txSignature = result.signature;
        signupBonus.distributedAt = new Date();
        await signupBonus.save();

        console.log(`✅ Signup bonus distributed: ${CONFIG.SIGNUP_BONUS_AMOUNT} GG to ${walletAddress.slice(0,8)}... (tx: ${result.signature.slice(0,16)}...)`);

        // === REFERRER BONUS: Send bonus to the person who referred this user ===
        let referrerBonusResult = null;
        if (referralInfo.referrerId) {
          try {
            const User = getUser();
            const referrer = await User.findById(referralInfo.referrerId);

            if (referrer && referrer.walletAddress) {
              console.log(`🎁 Processing referrer bonus for ${referrer.email}...`);

              const referrerResult = await this.distributionService.distributeTokens({
                venueId: 'referral_bonus',
                venueName: 'Referral Bonus System',
                recipient: referrer.walletAddress,
                amount: CONFIG.REFERRER_BONUS_AMOUNT,
                sourceAccount: CONFIG.SOURCE_ACCOUNT,
                metadata: {
                  type: 'referrer_bonus',
                  referrerId: referrer._id.toString(),
                  referrerEmail: referrer.email,
                  referredUserId: userId.toString(),
                  referredUserEmail: email
                }
              });

              if (referrerResult.success) {
                console.log(`✅ Referrer bonus distributed: ${CONFIG.REFERRER_BONUS_AMOUNT} GG to ${referrer.walletAddress.slice(0,8)}... (tx: ${referrerResult.signature.slice(0,16)}...)`);
                referrerBonusResult = {
                  success: true,
                  amount: CONFIG.REFERRER_BONUS_AMOUNT,
                  txSignature: referrerResult.signature,
                  referrerEmail: referrer.email
                };
              } else {
                console.error(`❌ Referrer bonus failed for ${referrer.email}:`, referrerResult.error);
                referrerBonusResult = { success: false, error: referrerResult.error };
              }
            } else if (referrer && !referrer.walletAddress) {
              console.log(`⏳ Referrer bonus deferred for ${referrer.email} - no wallet connected yet`);
              referrerBonusResult = { success: false, reason: 'referrer_no_wallet' };
            } else {
              console.log(`⚠️ Referrer not found: ${referralInfo.referrerId}`);
              referrerBonusResult = { success: false, reason: 'referrer_not_found' };
            }
          } catch (referrerError) {
            console.error(`❌ Referrer bonus error:`, referrerError.message);
            referrerBonusResult = { success: false, error: referrerError.message };
          }
        }

        return {
          success: true,
          amount: CONFIG.SIGNUP_BONUS_AMOUNT,
          txSignature: result.signature,
          explorerUrl: result.explorerUrl,
          referrerBonus: referrerBonusResult
        };
      } else {
        throw new Error(result.error || 'Distribution failed');
      }

    } catch (error) {
      console.error(`❌ Signup bonus failed for user ${userId}:`, error.message);

      signupBonus.status = 'failed';
      signupBonus.failureReason = error.message;
      await signupBonus.save();

      return {
        success: false,
        reason: 'transfer_failed',
        error: error.message
      };
    }
  }

  /**
   * Disburse KYC bonus to a user
   * Called when: venue staff verifies user KYC in person
   * 
   * @param {Object} params
   * @param {string} params.userId - MongoDB user ID
   * @param {string} params.walletAddress - Solana wallet address
   * @param {string} params.venueKycRewardId - VenueKycReward document ID
   * @returns {Object} Result with success status and tx signature
   */
  async disburseKycBonus({ userId, walletAddress, venueKycRewardId }) {
    console.log(`🎁 Processing KYC bonus for user ${userId}`);

    // Wallet validation - user must have created/connected a wallet first
    if (!walletAddress || walletAddress.length < 32) {
      console.log(`⏳ KYC bonus deferred for user ${userId} - no wallet connected yet`);
      return {
        success: false,
        reason: 'no_wallet',
        message: 'User has not created or connected a wallet yet'
      };
    }

    // Get the VenueKycReward record
    const kycReward = await VenueKycReward.findById(venueKycRewardId);
    if (!kycReward) {
      return {
        success: false,
        reason: 'kyc_reward_not_found'
      };
    }

    // Idempotency check
    if (kycReward.status === 'distributed' || kycReward.status === 'queued') {
      console.log(`⚠️ KYC bonus already distributed to user ${userId}`);
      return {
        success: false,
        reason: 'already_distributed',
        txSignature: kycReward.txSignature
      };
    }

    kycReward.status = 'queued';
    kycReward.retryCount = (kycReward.retryCount || 0) + 1;
    await kycReward.save();

    try {
      // Execute actual Solana token transfer
      const result = await this.distributionService.distributeTokens({
        venueId: kycReward.venueId,
        venueName: kycReward.venueName || 'KYC Verification',
        recipient: walletAddress,
        amount: CONFIG.KYC_BONUS_AMOUNT,
        sourceAccount: CONFIG.SOURCE_ACCOUNT,
        metadata: {
          type: 'kyc_bonus',
          userId: userId.toString(),
          venueId: kycReward.venueId,
          verifiedBy: kycReward.verifiedBy?.toString()
        }
      });

      if (result.success) {
        kycReward.status = 'distributed';
        kycReward.txSignature = result.signature;
        kycReward.distributedAt = new Date();
        await kycReward.save();

        console.log(`✅ KYC bonus distributed: ${CONFIG.KYC_BONUS_AMOUNT} GG to ${walletAddress.slice(0,8)}... (tx: ${result.signature.slice(0,16)}...)`);

        return {
          success: true,
          amount: CONFIG.KYC_BONUS_AMOUNT,
          txSignature: result.signature,
          explorerUrl: result.explorerUrl
        };
      } else {
        throw new Error(result.error || 'Distribution failed');
      }

    } catch (error) {
      console.error(`❌ KYC bonus failed for user ${userId}:`, error.message);

      kycReward.status = 'failed';
      kycReward.failureReason = error.message;
      await kycReward.save();

      return {
        success: false,
        reason: 'transfer_failed',
        error: error.message
      };
    }
  }

  /**
   * Process all pending signup bonuses (batch job)
   */
  async processPendingSignupBonuses(limit = 50) {
    console.log('🔄 Processing pending signup bonuses...');

    const pending = await SignupBonus.find({
      status: { $in: ['pending', 'failed'] },
      retryCount: { $lt: CONFIG.MAX_RETRIES }
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .populate('userId', 'walletAddress email');

    if (pending.length === 0) {
      console.log('✅ No pending signup bonuses to process');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    console.log(`📋 Found ${pending.length} pending signup bonuses`);

    let succeeded = 0;
    let failed = 0;

    for (const bonus of pending) {
      if (!bonus.userId?.walletAddress) {
        console.log(`⚠️ Skipping bonus ${bonus._id} - user has no wallet`);
        continue;
      }

      const result = await this.disburseSignupBonus({
        userId: bonus.userId._id,
        walletAddress: bonus.userId.walletAddress,
        email: bonus.userId.email
      });

      if (result.success) {
        succeeded++;
      } else if (result.reason !== 'already_distributed') {
        failed++;
      }

      // Delay between transfers to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`✅ Signup bonus batch complete: ${succeeded} succeeded, ${failed} failed`);
    return { processed: pending.length, succeeded, failed };
  }

  /**
   * Process all pending KYC bonuses (batch job)
   */
  async processPendingKycBonuses(limit = 50) {
    console.log('🔄 Processing pending KYC bonuses...');

    const pending = await VenueKycReward.find({
      status: { $in: ['pending', 'queued', 'failed'] },
      retryCount: { $lt: CONFIG.MAX_RETRIES }
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .populate('userId', 'walletAddress');

    if (pending.length === 0) {
      console.log('✅ No pending KYC bonuses to process');
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    console.log(`📋 Found ${pending.length} pending KYC bonuses`);

    let succeeded = 0;
    let failed = 0;

    for (const reward of pending) {
      if (!reward.userId?.walletAddress) {
        console.log(`⚠️ Skipping KYC reward ${reward._id} - user has no wallet`);
        continue;
      }

      const result = await this.disburseKycBonus({
        userId: reward.userId._id,
        walletAddress: reward.userId.walletAddress,
        venueKycRewardId: reward._id
      });

      if (result.success) {
        succeeded++;
      } else if (result.reason !== 'already_distributed') {
        failed++;
      }

      // Delay between transfers
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`✅ KYC bonus batch complete: ${succeeded} succeeded, ${failed} failed`);
    return { processed: pending.length, succeeded, failed };
  }

  /**
   * Get disbursement statistics
   */
  async getStats() {
    const [signupStats] = await SignupBonus.getStats();
    const kycStats = await VenueKycReward.aggregate([
      {
        $group: {
          _id: null,
          totalRewards: { $sum: 1 },
          distributedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, 1, 0] }
          },
          distributedAmount: {
            $sum: { $cond: [{ $eq: ['$status', 'distributed'] }, '$rewardAmount', 0] }
          },
          pendingCount: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'queued']] }, 1, 0] }
          }
        }
      }
    ]);

    return {
      signup: signupStats || { totalBonuses: 0, distributedCount: 0, pendingCount: 0 },
      kyc: kycStats[0] || { totalRewards: 0, distributedCount: 0, pendingCount: 0 },
      config: {
        signupBonusAmount: CONFIG.SIGNUP_BONUS_AMOUNT,
        kycBonusAmount: CONFIG.KYC_BONUS_AMOUNT,
        sourceAccount: CONFIG.SOURCE_ACCOUNT
      }
    };
  }
}

module.exports = BonusDisbursementService;
