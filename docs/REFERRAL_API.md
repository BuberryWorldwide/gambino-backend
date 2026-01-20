# Referral System API

Technical reference for the Gambino Gold referral system.

## Overview

Users with KYC verification get a referral code. When new users sign up with that code:
- New user gets signup bonus (25 GG)
- Referrer gets referrer bonus (25 GG)
- Referral is tracked for stats/history

## API Endpoints

### `POST /api/referral/validate`

Validate a referral code (public, no auth required).

**Request:**
```json
{
  "code": "MX2864"
}
```

**Response (valid):**
```json
{
  "valid": true,
  "referrer": {
    "firstName": "Brandon",
    "lastInitial": "M."
  },
  "rewards": {
    "newUser": 25,
    "referrer": 25
  }
}
```

**Response (invalid):**
```json
{
  "valid": false,
  "error": "Referral code not found"
}
```

### `GET /api/referral/stats`

Get referral statistics for the authenticated user.

**Auth:** Required (JWT)

**Response:**
```json
{
  "totalReferrals": 5,
  "pendingReferrals": 1,
  "verifiedReferrals": 4,
  "totalRewards": 100,
  "monthlyReferrals": 2
}
```

### `GET /api/referral/history`

Get list of people the user has referred.

**Auth:** Required (JWT)

**Query params:**
- `page` (default: 1)
- `limit` (default: 20, max: 50)

**Response:**
```json
{
  "referrals": [
    {
      "id": "696eef10f0bfa14892173e0d",
      "newUserName": "Test D.",
      "status": "distributed",
      "rewardAmount": 25,
      "createdAt": "2026-01-20T02:45:00.000Z",
      "distributedAt": "2026-01-20T02:50:00.000Z",
      "firstSessionAt": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

## Referral Model

Location: `src/models/Referral.js`

```javascript
{
  // Participants
  referrerId: ObjectId,      // Who referred (required)
  newUserId: ObjectId,       // Who was referred (required, unique)
  venueId: string,           // storeId where referral occurred

  // Status tracking
  status: 'pending' | 'pending_budget' | 'verified' | 'distributed' | 'clawed_back' | 'rejected',

  // Reward amounts (based on referrer tier at time of referral)
  amounts: {
    referrer: number,        // GG for referrer (e.g., 25-350 based on tier)
    newUser: number,         // GG for new user (e.g., 100)
    venue: number            // GG for venue (e.g., 50)
  },
  referrerTier: 'none' | 'bronze' | 'silver' | 'gold',

  // Distribution tracking
  distributedAt: Date,
  txSignatures: {
    referrer: string,        // Solana tx for referrer payment
    newUser: string,         // Solana tx for new user payment
    venue: string            // Solana tx for venue payment
  },

  // Verification
  firstSessionAt: Date,      // When new user completed first mining session
  kycCompletedAt: Date,

  // Clawback/rejection
  clawbackReason: string,
  clawbackAt: Date,
  rejectionReason: string,
  rejectedAt: Date,

  // Metadata
  referralCode: string,
  source: 'qr' | 'link' | 'social' | 'direct',

  createdAt: Date,
  updatedAt: Date
}
```

## Status Flow

```
User signs up with referral code
         │
         ▼
     [pending]
         │
         ├─── User completes first session within 14 days ───▶ [verified] ───▶ [distributed]
         │
         ├─── Monthly budget exhausted ───▶ [pending_budget] ───▶ (next month) ───▶ [distributed]
         │
         ├─── 14 days pass without first session ───▶ [clawed_back]
         │
         └─── Abuse detected ───▶ [rejected]
```

## Tier-Based Rewards

Referrer's tier affects reward amounts:

| Tier | Referrer Gets | New User Gets | Venue Gets | Total |
|------|--------------|---------------|------------|-------|
| Gold | 350 GG | 100 GG | 50 GG | 500 GG |
| Silver | 300 GG | 100 GG | 50 GG | 450 GG |
| Bronze | 250 GG | 100 GG | 50 GG | 400 GG |
| None | 150 GG | 100 GG | 50 GG | 300 GG |

*Note: Current simplified implementation uses flat 25 GG for referrer bonus.*

## Static Methods

### `Referral.getUserStats(userId)`

Get aggregate stats for a user's referrals.

```javascript
const stats = await Referral.getUserStats(userId);
// {
//   totalReferrals: 5,
//   pendingReferrals: 1,
//   verifiedReferrals: 2,
//   distributedReferrals: 2,
//   totalRewards: 50,
//   monthlyReferrals: 2
// }
```

### `Referral.calculateRewards(tier)`

Calculate reward amounts based on tier.

```javascript
const rewards = Referral.calculateRewards('gold');
// { referrer: 350, newUser: 100, venue: 50 }
```

### `Referral.getLeaderboard(options)`

Get top referrers.

```javascript
const leaderboard = await Referral.getLeaderboard({
  timeframe: 'month',  // 'all', 'month', 'week'
  limit: 50
});
```

## Frontend Integration

The gambino-users frontend uses:

- `useReferral` hook (`src/lib/useReferral.js`) - fetches stats and history
- `referralAPI` (`src/lib/api.js`) - API client methods
- `ReferralTab` component - displays referral code, QR, stats, history

## Creating a Referral Record

When a new user signs up with a referral code:

1. Onboarding saves `referredBy` field on User document
2. When bonus is disbursed, create Referral record:

```javascript
const referral = new Referral({
  referrerId: brandon._id,
  newUserId: newUser._id,
  status: 'distributed',
  amounts: { referrer: 25, newUser: 25, venue: 0 },
  referrerTier: brandon.tier || 'none',
  distributedAt: new Date(),
  referralCode: brandon.referralCode,
  source: 'link'
});
await referral.save();
```

---

*Last updated: 2026-01-20*
