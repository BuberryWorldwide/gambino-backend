/**
 * Referral Token Distribution Service
 *
 * Handles GG token distribution for referral rewards
 * Uses Community Treasury for distributions
 * Budget cap: 0.5% of treasury per month (~169,825 GG)
 */

const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Configuration
const CONFIG = {
  // GG Token Mint
  TOKEN_MINT: new PublicKey('Cd2wZyKVdWuyuJJHmeU1WmfSKNnDHku2m6mt6XFqGeXn'),

  // Token decimals (GG has 9 decimals)
  DECIMALS: 9,

  // Monthly budget cap (0.5% of 33,965,000 GG Community Treasury)
  MONTHLY_BUDGET_GG: 169825,

  // Solana RPC endpoint
  RPC_ENDPOINT: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
};

// Cache connection
let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');
  }
  return _connection;
}

/**
 * Initialize keypairs from environment variables
 */
function getKeypairs() {
  const communityKey = process.env.COMMUNITY_TREASURY_KEY;
  if (!communityKey) throw new Error('COMMUNITY_TREASURY_KEY not set');

  const payerKey = process.env.PAYER_KEY;
  if (!payerKey) throw new Error('PAYER_KEY not set');

  return {
    community: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(communityKey))),
    payer: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerKey)))
  };
}

/**
 * Convert GG amount to token lamports (9 decimals)
 */
function toTokenAmount(gg) {
  return BigInt(Math.floor(gg * Math.pow(10, CONFIG.DECIMALS)));
}

/**
 * Check if we have budget remaining for this month
 */
async function hasBudgetRemaining(Referral, amountNeeded) {
  const usage = await Referral.getMonthlyBudgetUsage();
  const remaining = CONFIG.MONTHLY_BUDGET_GG - usage.totalDistributed;

  console.log(`📊 Monthly budget: ${usage.totalDistributed.toLocaleString()}/${CONFIG.MONTHLY_BUDGET_GG.toLocaleString()} GG used (${usage.referralCount} referrals), ${remaining.toLocaleString()} remaining`);

  return remaining >= amountNeeded;
}

/**
 * Transfer GG tokens to a recipient
 */
async function transferTokens(connection, keypairs, recipientAddress, amount) {
  try {
    const recipientPubkey = new PublicKey(recipientAddress);
    const amountLamports = toTokenAmount(amount);

    // Get or create token accounts
    const sourceAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypairs.payer,
      CONFIG.TOKEN_MINT,
      keypairs.community.publicKey
    );

    const destAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypairs.payer,
      CONFIG.TOKEN_MINT,
      recipientPubkey
    );

    // Create transfer instruction
    const transferIx = createTransferInstruction(
      sourceAccount.address,
      destAccount.address,
      keypairs.community.publicKey,
      amountLamports,
      [],
      TOKEN_PROGRAM_ID
    );

    // Build transaction
    const transaction = new Transaction().add(transferIx);
    transaction.feePayer = keypairs.payer.publicKey;

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Sign with community (token owner) and payer (fee payer)
    transaction.sign(keypairs.community, keypairs.payer);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    console.log(`✅ Transferred ${amount} GG to ${recipientAddress.slice(0, 8)}... (tx: ${signature.slice(0, 16)}...)`);

    return { success: true, signature };
  } catch (error) {
    console.error(`❌ Transfer failed to ${recipientAddress}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Distribute rewards for a single verified referral
 */
async function distributeReferralRewards(referral, User, Referral, Store = null) {
  const connection = getConnection();
  let keypairs;

  try {
    keypairs = getKeypairs();
  } catch (error) {
    console.error('❌ Failed to load keypairs:', error.message);
    return { success: false, reason: 'keypairs_error' };
  }

  // Get reward amounts from the referral (already calculated based on tier)
  const amounts = referral.amounts || Referral.calculateRewards(referral.referrerTier);
  const totalNeeded = amounts.referrer + amounts.newUser + (referral.venueId ? amounts.venue : 0);

  // Check budget
  const hasBudget = await hasBudgetRemaining(Referral, totalNeeded);
  if (!hasBudget) {
    // Move to pending_budget status
    await Referral.findByIdAndUpdate(referral._id, {
      status: 'pending_budget',
      queuedAt: new Date()
    });
    console.warn(`⚠️ Monthly budget exhausted, referral ${referral._id} queued for next month`);
    return { success: false, reason: 'budget_exhausted' };
  }

  // Get user wallets
  const referrer = await User.findById(referral.referrerId).lean();
  const newUser = await User.findById(referral.newUserId).lean();

  if (!referrer?.walletAddress) {
    console.warn(`⚠️ Referrer ${referral.referrerId} has no wallet, keeping verified`);
    return { success: false, reason: 'referrer_no_wallet' };
  }

  if (!newUser?.walletAddress) {
    console.warn(`⚠️ New user ${referral.newUserId} has no wallet, keeping verified`);
    return { success: false, reason: 'new_user_no_wallet' };
  }

  const results = {
    referrer: null,
    newUser: null,
    venue: null
  };

  // Transfer to referrer
  console.log(`💸 Distributing ${amounts.referrer} GG to referrer...`);
  results.referrer = await transferTokens(
    connection,
    keypairs,
    referrer.walletAddress,
    amounts.referrer
  );

  if (!results.referrer.success) {
    return { success: false, reason: 'referrer_transfer_failed', results };
  }

  // Transfer to new user
  console.log(`💸 Distributing ${amounts.newUser} GG to new user...`);
  results.newUser = await transferTokens(
    connection,
    keypairs,
    newUser.walletAddress,
    amounts.newUser
  );

  // Transfer to venue if applicable
  if (referral.venueId && Store && amounts.venue > 0) {
    const venue = await Store.findOne({ storeId: referral.venueId }).lean();
    if (venue?.walletAddress) {
      console.log(`💸 Distributing ${amounts.venue} GG to venue...`);
      results.venue = await transferTokens(
        connection,
        keypairs,
        venue.walletAddress,
        amounts.venue
      );
    }
  }

  // Update referral record
  const updateData = {
    status: 'distributed',
    distributedAt: new Date(),
    amounts: {
      referrer: results.referrer.success ? amounts.referrer : 0,
      newUser: results.newUser?.success ? amounts.newUser : 0,
      venue: results.venue?.success ? amounts.venue : 0
    },
    txSignatures: {
      referrer: results.referrer.signature,
      newUser: results.newUser?.signature,
      venue: results.venue?.signature
    }
  };

  await Referral.findByIdAndUpdate(referral._id, updateData);

  // Update referrer's reward total
  if (results.referrer.success) {
    await User.findByIdAndUpdate(referral.referrerId, {
      $inc: { referralRewards: amounts.referrer }
    });
  }

  console.log(`🎉 Referral ${referral._id} distributed: ${amounts.referrer} + ${amounts.newUser} + ${amounts.venue || 0} GG`);

  return { success: true, results, amounts };
}

/**
 * Batch process all verified referrals
 */
async function processVerifiedReferrals(User, Referral, Store = null) {
  console.log('🔄 Starting referral distribution batch job...');

  // Find all verified referrals where both users have wallets
  const verifiedReferrals = await Referral.find({ status: 'verified' }).lean();

  if (verifiedReferrals.length === 0) {
    console.log('✅ No verified referrals to process');
    return { processed: 0, succeeded: 0, failed: 0, budgetExhausted: false };
  }

  console.log(`📋 Found ${verifiedReferrals.length} verified referrals to process`);

  let succeeded = 0;
  let failed = 0;
  let budgetExhausted = false;

  for (const referral of verifiedReferrals) {
    try {
      const result = await distributeReferralRewards(referral, User, Referral, Store);

      if (result.success) {
        succeeded++;
      } else {
        failed++;
        if (result.reason === 'budget_exhausted') {
          budgetExhausted = true;
          console.log('⚠️ Budget exhausted, stopping batch');
          break;
        }
      }
    } catch (error) {
      console.error(`❌ Error processing referral ${referral._id}:`, error);
      failed++;
    }

    // Delay between transfers to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`✅ Batch complete: ${succeeded} succeeded, ${failed} failed`);

  return {
    processed: verifiedReferrals.length,
    succeeded,
    failed,
    budgetExhausted
  };
}

/**
 * Process queued referrals from previous months (pending_budget status)
 */
async function processQueuedReferrals(User, Referral, Store = null) {
  console.log('🔄 Processing queued referrals from previous months...');

  const queuedReferrals = await Referral.find({ status: 'pending_budget' })
    .sort({ queuedAt: 1 })
    .lean();

  if (queuedReferrals.length === 0) {
    console.log('✅ No queued referrals');
    return { processed: 0, succeeded: 0 };
  }

  console.log(`📋 Found ${queuedReferrals.length} queued referrals`);

  let succeeded = 0;

  for (const referral of queuedReferrals) {
    // Update status to verified to re-process
    await Referral.findByIdAndUpdate(referral._id, { status: 'verified' });

    const result = await distributeReferralRewards(
      { ...referral, status: 'verified' },
      User,
      Referral,
      Store
    );

    if (result.success) {
      succeeded++;
    } else if (result.reason === 'budget_exhausted') {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { processed: queuedReferrals.length, succeeded };
}

/**
 * Mark referral as verified when user completes first session (5+ min)
 */
async function verifyReferralOnSessionComplete(userId, sessionDurationMinutes, Referral) {
  // Minimum 5 minutes for session to count
  if (sessionDurationMinutes < 5) {
    console.log(`⏱️ Session too short (${sessionDurationMinutes} min), need 5+ min`);
    return { verified: false, reason: 'session_too_short' };
  }

  const referral = await Referral.findOne({
    newUserId: userId,
    status: 'pending'
  });

  if (!referral) {
    return { verified: false, reason: 'no_pending_referral' };
  }

  await Referral.findByIdAndUpdate(referral._id, {
    status: 'verified',
    firstSessionAt: new Date()
  });

  console.log(`✅ Referral verified for user ${userId} after ${sessionDurationMinutes} min session`);

  return {
    verified: true,
    referralId: referral._id,
    referrerId: referral.referrerId
  };
}

/**
 * Process stale referrals (older than 14 days without session)
 */
async function processStaleReferrals(Referral) {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const staleReferrals = await Referral.find({
    status: 'pending',
    firstSessionAt: null,
    createdAt: { $lt: fourteenDaysAgo }
  });

  let clawedBack = 0;

  for (const referral of staleReferrals) {
    await Referral.findByIdAndUpdate(referral._id, {
      status: 'clawed_back',
      clawbackAt: new Date(),
      clawbackReason: 'No session within 14 days'
    });
    clawedBack++;
  }

  if (clawedBack > 0) {
    console.log(`🗑️ Clawed back ${clawedBack} stale referrals`);
  }

  return { clawedBack };
}

/**
 * Get distribution statistics
 */
async function getDistributionStats(Referral) {
  const monthlyUsage = await Referral.getMonthlyBudgetUsage();

  const allTimeStats = await Referral.aggregate([
    { $match: { status: 'distributed' } },
    {
      $group: {
        _id: null,
        totalDistributed: {
          $sum: { $add: ['$amounts.referrer', '$amounts.newUser', '$amounts.venue'] }
        },
        totalReferrals: { $sum: 1 }
      }
    }
  ]);

  const pendingCount = await Referral.countDocuments({ status: 'pending' });
  const verifiedCount = await Referral.countDocuments({ status: 'verified' });
  const queuedCount = await Referral.countDocuments({ status: 'pending_budget' });

  return {
    monthly: {
      distributed: monthlyUsage.totalDistributed,
      budget: CONFIG.MONTHLY_BUDGET_GG,
      remaining: CONFIG.MONTHLY_BUDGET_GG - monthlyUsage.totalDistributed,
      referralCount: monthlyUsage.referralCount
    },
    allTime: {
      distributed: allTimeStats[0]?.totalDistributed || 0,
      referralCount: allTimeStats[0]?.totalReferrals || 0
    },
    queue: {
      pending: pendingCount,
      verified: verifiedCount,
      queuedForBudget: queuedCount
    }
  };
}

module.exports = {
  CONFIG,
  distributeReferralRewards,
  processVerifiedReferrals,
  processQueuedReferrals,
  verifyReferralOnSessionComplete,
  processStaleReferrals,
  hasBudgetRemaining,
  getDistributionStats
};
