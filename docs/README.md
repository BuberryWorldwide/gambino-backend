# Gambino Gold Backend Documentation

Technical documentation for the Gambino Gold backend system.

## Documents

| Document | Description |
|----------|-------------|
| [BONUS_DISBURSEMENT.md](./BONUS_DISBURSEMENT.md) | Token bonus system (signup, referrer, KYC bonuses) |
| [REFERRAL_API.md](./REFERRAL_API.md) | Referral system API endpoints and data model |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Gambino Gold Backend                      │
│                      (Express.js + MongoDB)                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Auth       │  │   Wallet     │  │   Mining     │      │
│  │   Routes     │  │   Routes     │  │   Routes     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Referral   │  │   KYC        │  │   Admin      │      │
│  │   Routes     │  │   Routes     │  │   Routes     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                        Services                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  BonusDisbursementService  │  DistributionService    │  │
│  │  - Signup bonuses          │  - Solana token xfers   │  │
│  │  - Referrer bonuses        │  - Treasury management  │  │
│  │  - KYC bonuses             │                         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                        Models                                │
│  User, Referral, SignupBonus, VenueKycReward, Distribution  │
│  Session, Transfer, Transaction, Machine, Event, Store...   │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                     External Services                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Solana     │  │   SendGrid   │  │   MongoDB    │      │
│  │   (Tokens)   │  │   (Email)    │  │   Atlas      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Flows

### New User Signup with Referral

```
1. User enters referral code during onboarding
2. POST /api/referral/validate → confirms code is valid
3. User completes registration → referredBy saved on User doc
4. User verifies email
5. User creates/attaches wallet
6. BonusDisbursementService.disburseSignupBonus() triggered:
   - Sends 25 GG to new user
   - Sends 25 GG to referrer
   - Creates Referral record
7. User sees balance in dashboard
8. Referrer sees referral in history
```

### Token Distribution

```
1. Service calls distributionService.distributeTokens()
2. DistributionService loads treasury keypair from CredentialManager
3. Creates Solana transaction (SPL token transfer)
4. Signs with treasury keypair
5. Sends to Solana mainnet via Alchemy RPC
6. Waits for confirmation
7. Returns tx signature
```

## Environment Variables

See `.env.example` for full list. Key variables:

```env
# MongoDB
MONGODB_URI=mongodb+srv://...

# Solana
SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/...
GAMBINO_MINT_ADDRESS=Cd2wZyKVdWuyuJJHmeU1WmfSKNnDHku2m6mt6XFqGeXn

# Bonuses
SIGNUP_BONUS_AMOUNT=25
REFERRER_BONUS_AMOUNT=25
KYC_BONUS_AMOUNT=25

# JWT
JWT_SECRET=...
```

## Deployment

Backend runs on Ubuntu server via PM2:

```bash
# SSH to server
ssh -p 2222 nhac@192.168.1.235

# Backend location
cd /opt/gambino/backend

# Restart
pm2 restart gambino-backend

# Logs
pm2 logs gambino-backend --lines 100
```

## Git Workflow

```bash
# On local machine - edit files
vim /home/nhac/Downloads/gambino-backend-backup-local/backend/...

# SCP to production
scp -P 2222 file.js nhac@192.168.1.235:/opt/gambino/backend/file.js

# On server - restart
pm2 restart gambino-backend

# On server - commit for versioning
git add -A && git commit -m "description"
git push
```

---

*Last updated: 2026-01-20*
