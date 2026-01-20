# Bonus Disbursement System

Technical reference for the Gambino Gold token bonus disbursement system.

## Overview

The bonus system automatically distributes GG tokens from the community treasury when users complete certain actions:

1. **Signup Bonus** - When a new user verifies email + creates wallet
2. **Referrer Bonus** - When someone signs up using a referral code
3. **KYC Bonus** - When a user completes in-person KYC at a venue

## Configuration

Environment variables (`.env`):

```env
SIGNUP_BONUS_AMOUNT=25      # GG tokens for new user signup
REFERRER_BONUS_AMOUNT=25    # GG tokens for referrer
KYC_BONUS_AMOUNT=25         # GG tokens for KYC completion
```

## Service: `bonusDisbursementService.js`

Location: `src/services/bonusDisbursementService.js`

### Methods

#### `disburseSignupBonus(params)`

Distributes signup bonus to new user and referrer bonus to their referrer.

```javascript
const result = await bonusService.disburseSignupBonus({
  userId: ObjectId,           // MongoDB user ID
  walletAddress: string,      // Solana wallet address
  email: string,              // User email (for logging)
  referralInfo: {
    referrerId: ObjectId,     // Who referred this user (optional)
    referralCode: string      // Code used (optional)
  }
});
```

**Flow:**
1. Validate wallet address exists
2. Check idempotency (already distributed?)
3. Send signup bonus to new user's wallet
4. If `referralInfo.referrerId` exists:
   - Look up referrer's wallet
   - Send referrer bonus to referrer's wallet
5. Return result with tx signatures

**Returns:**
```javascript
{
  success: true,
  amount: 25,
  txSignature: "5abc123...",
  explorerUrl: "https://explorer.solana.com/tx/...",
  referrerBonus: {
    success: true,
    amount: 25,
    txSignature: "7def456...",
    referrerEmail: "referrer@example.com"
  }
}
```

#### `disburseKycBonus(params)`

Distributes KYC bonus when venue staff verifies user identity.

```javascript
const result = await bonusService.disburseKycBonus({
  userId: ObjectId,
  walletAddress: string,
  venueKycRewardId: ObjectId  // VenueKycReward document ID
});
```

### Batch Processing

For retrying failed distributions:

```javascript
// Process pending signup bonuses
await bonusService.processPendingSignupBonuses(limit = 50);

// Process pending KYC bonuses
await bonusService.processPendingKycBonuses(limit = 50);
```

## Models

### SignupBonus

Tracks signup bonus disbursement status.

```javascript
{
  userId: ObjectId,
  userEmail: string,
  walletAddress: string,
  amount: number,              // GG amount
  status: 'pending' | 'processing' | 'distributed' | 'failed',
  trigger: 'email_verified',
  referredBy: ObjectId,        // Who referred this user
  referralCode: string,
  txSignature: string,         // Solana tx signature
  distributedAt: Date,
  failureReason: string,
  retryCount: number
}
```

### VenueKycReward

Tracks KYC bonus disbursement status.

```javascript
{
  userId: ObjectId,
  venueId: string,
  venueName: string,
  rewardAmount: number,
  status: 'pending' | 'queued' | 'distributed' | 'failed',
  verifiedBy: ObjectId,        // Staff who verified
  txSignature: string,
  distributedAt: Date
}
```

## Trigger Points

### Wallet Attach (`server.js`)

When user attaches/creates wallet (`POST /api/wallet/attach`):

```javascript
// After wallet is saved, trigger bonus in background
if (user.isVerified) {
  setImmediate(async () => {
    const bonusService = new BonusDisbursementService();
    await bonusService.disburseSignupBonus({
      userId: user._id,
      walletAddress: publicKey,
      email: user.email,
      referralInfo: {
        referrerId: user.referredBy,
        referralCode: null
      }
    });
  });
}
```

The `setImmediate()` ensures the response returns immediately - bonus is processed in background.

## Solana Integration

Uses `DistributionService` for actual token transfers:

```javascript
const result = await distributionService.distributeTokens({
  venueId: 'signup_bonus',
  venueName: 'Signup Bonus System',
  recipient: walletAddress,
  amount: 25,
  sourceAccount: 'community',  // Maps to communityRewards treasury
  metadata: { type: 'signup_bonus', userId, email }
});
```

## Error Handling

Common errors:
- `no_wallet` - User hasn't created wallet yet
- `already_distributed` - Idempotency check failed
- `already_processing` - Concurrent request
- `transfer_failed` - Solana RPC error

RPC issues (block height exceeded, timeouts) are logged but don't block the response since bonus is fire-and-forget.

## Debugging

Check bonus status in MongoDB:

```javascript
// Find signup bonus record
db.signupbonuses.findOne({ userId: ObjectId("...") })

// Find all failed bonuses
db.signupbonuses.find({ status: "failed" })
```

Check PM2 logs for disbursement activity:

```bash
pm2 logs gambino-backend --lines 100 | grep -i bonus
```

---

*Last updated: 2026-01-20*
