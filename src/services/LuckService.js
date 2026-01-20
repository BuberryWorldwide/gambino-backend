// backend/src/services/LuckService.js
// Proof of Luck service - Gambino business layer
// Consumes Arca Protocol's entropy draw API

const crypto = require('crypto');
const mongoose = require('mongoose');

// Get models from mongoose - they're already compiled by server.js
const getLuckEventModel = () => {
  // Check if model is already compiled
  if (mongoose.models.LuckEvent) {
    return mongoose.models.LuckEvent;
  }
  // If not, require it (this will compile it)
  return require('../models/LuckEvent');
};

// Arca API configuration
const ARCA_API_URL = process.env.ARCA_API_URL || 'https://api.arca-protocol.com';

// Rarity configuration
const RARITY_CONFIG = {
  RARE: {
    odds: 500,            // 1 in 500
    threshold: 100,       // roll < 100 out of 50000
    governancePoints: 1,
    ggEmission: 500,      // 500 GG per RARE hit
    name: 'Lucky Strike'
  },
  EPIC: {
    odds: 5000,           // 1 in 5000
    threshold: 10,        // roll < 10 out of 50000
    governancePoints: 5,
    ggEmission: 2500,     // 2,500 GG per EPIC hit
    name: 'Golden Event'
  },
  LEGENDARY: {
    odds: 50000,          // 1 in 50000
    threshold: 1,         // roll < 1 (only 0 wins)
    governancePoints: 25,
    ggEmission: 12500,    // 12,500 GG per LEGENDARY hit
    name: 'Protocol Witness'
  }
};

// Cooldown after hitting (bits required before next check)
const COOLDOWN_BITS = {
  RARE: 100,
  EPIC: 250,
  LEGENDARY: 500
};

// Milestone: bits required to trigger a luck check
const MILESTONE_BITS = parseInt(process.env.LUCK_MILESTONE_BITS) || 50;

// Roll space
const MAX_ROLL = 50000;

class LuckService {
  constructor() {
    // In-memory state tracking (could be moved to Redis for scale)
    // Format: { minerId: { bitsSinceLastCheck, bitsUntilEligible, totalBits, totalChecks, totalHits } }
    this.minerState = new Map();
    this.User = null; // Will be injected
  }

  /**
   * Set the User model (injected from server.js to avoid circular deps)
   */
  setUserModel(User) {
    this.User = User;
  }

  /**
   * Get or create miner state
   */
  getMinerState(minerId) {
    if (!this.minerState.has(minerId)) {
      this.minerState.set(minerId, {
        bitsSinceLastCheck: 0,
        bitsUntilEligible: 0,
        totalBitsContributed: 0,
        totalChecks: 0,
        totalHits: 0,
        lastCheckAt: null,
        lastHitAt: null
      });
    }
    return this.minerState.get(minerId);
  }

  /**
   * Record a contribution and check for luck
   * Called after user contributes entropy (e.g., plays a game)
   *
   * @param userId - MongoDB user ID
   * @param bitsContributed - Number of entropy bits contributed
   * @param gameContext - Context/game name
   * @returns LuckCheckResult
   */
  async recordContributionAndCheckLuck(userId, bitsContributed, gameContext) {
    const minerId = userId.toString();
    const state = this.getMinerState(minerId);

    // Update contribution totals
    state.bitsSinceLastCheck += bitsContributed;
    state.totalBitsContributed += bitsContributed;

    // Reduce cooldown
    if (state.bitsUntilEligible > 0) {
      state.bitsUntilEligible = Math.max(0, state.bitsUntilEligible - bitsContributed);
    }

    // Check if milestone reached
    const milestoneIndex = Math.floor(state.bitsSinceLastCheck / MILESTONE_BITS);
    if (milestoneIndex === 0) {
      return {
        checked: false,
        reason: 'below_milestone',
        bitsUntilNextCheck: MILESTONE_BITS - state.bitsSinceLastCheck,
        state: this.getPublicState(state)
      };
    }

    // Check cooldown
    if (state.bitsUntilEligible > 0) {
      return {
        checked: false,
        reason: 'cooldown',
        bitsUntilNextCheck: state.bitsUntilEligible,
        state: this.getPublicState(state)
      };
    }

    // Perform luck check
    try {
      const result = await this.performLuckCheck(userId, minerId, gameContext);

      // Reset milestone counter
      state.bitsSinceLastCheck = 0;
      state.totalChecks++;
      state.lastCheckAt = new Date();

      if (result.hit) {
        state.totalHits++;
        state.lastHitAt = new Date();
        // Apply cooldown
        state.bitsUntilEligible = COOLDOWN_BITS[result.proof.rarityTier];
      }

      return {
        checked: true,
        hit: result.hit,
        proof: result.proof,
        state: this.getPublicState(state)
      };

    } catch (error) {
      console.error('Luck check failed:', error);
      return {
        checked: false,
        reason: 'error',
        error: error.message,
        state: this.getPublicState(state)
      };
    }
  }

  /**
   * Perform the actual luck check by drawing entropy from Arca
   */
  async performLuckCheck(userId, minerId, gameContext) {
    const LuckEvent = getLuckEventModel();

    // Draw entropy from Arca pool
    const draw = await this.drawEntropyFromArca(minerId, gameContext);

    // Convert entropy to roll value
    const rollValue = this.entropyToRoll(draw.entropy);

    // Determine rarity
    const rarityTier = this.determineRarity(rollValue);

    if (!rarityTier) {
      // No hit
      return {
        hit: false,
        rollValue,
        drawId: draw.drawId
      };
    }

    // HIT! Create luck event
    const config = RARITY_CONFIG[rarityTier];
    const eventId = `luck-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const luckEvent = await LuckEvent.create({
      userId,
      eventId,
      rarityTier,
      ggEmission: config.ggEmission,
      governancePoints: config.governancePoints,
      rollValue,
      threshold: config.threshold,
      arcaDrawId: draw.drawId,
      entropyHex: draw.entropy,
      gameContext,
      sourcePackets: draw.sources || [],
      payoutStatus: 'pending'
    });

    // Update user's governance points and luck stats
    if (this.User) {
      await this.User.findByIdAndUpdate(userId, {
        $inc: {
          gluckScore: config.governancePoints,
          totalLuckHits: 1,
          [`luckHits.${rarityTier}`]: 1
        },
        $push: {
          luckyEvents: {
            type: rarityTier.toLowerCase(),
            amount: config.ggEmission,
            gluckBonus: config.governancePoints,
            timestamp: new Date(),
            verified: true
          }
        }
      });
    }

    console.log(`[LUCK HIT] ${rarityTier} for user ${userId} - Roll: ${rollValue}, GG: ${config.ggEmission}`);

    return {
      hit: true,
      proof: {
        eventId,
        rarityTier,
        rarityName: config.name,
        rollValue,
        threshold: config.threshold,
        odds: config.odds,
        ggEmission: config.ggEmission,
        governancePoints: config.governancePoints,
        arcaDrawId: draw.drawId,
        timestamp: luckEvent.createdAt
      }
    };
  }

  /**
   * Draw entropy from Arca Protocol API
   */
  async drawEntropyFromArca(requesterId, purpose) {
    try {
      const response = await fetch(`${ARCA_API_URL}/v1/entropy/draw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          bits: 32,
          minQuality: 0.3,
          requesterId,
          purpose: `luck-check-${purpose}`
        })
      });

      if (!response.ok) {
        // If Arca API unavailable, fall back to local RNG
        console.warn('Arca API unavailable, using local RNG fallback');
        return this.localEntropyFallback(requesterId);
      }

      return await response.json();

    } catch (error) {
      console.warn('Arca API error, using local RNG fallback:', error.message);
      return this.localEntropyFallback(requesterId);
    }
  }

  /**
   * Fallback when Arca API is unavailable
   * Uses cryptographically secure local RNG
   */
  localEntropyFallback(requesterId) {
    const entropy = crypto.randomBytes(4).toString('hex');
    return {
      drawId: `local-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      entropy,
      source: 'local-fallback',
      warning: 'Using local RNG - Arca pool unavailable'
    };
  }

  /**
   * Convert entropy hex to roll value [0, 49999]
   */
  entropyToRoll(entropyHex) {
    const value = parseInt(entropyHex.slice(0, 8), 16);
    return value % MAX_ROLL;
  }

  /**
   * Determine rarity tier from roll value
   */
  determineRarity(roll) {
    if (roll < RARITY_CONFIG.LEGENDARY.threshold) {
      return 'LEGENDARY';
    }
    if (roll < RARITY_CONFIG.EPIC.threshold) {
      return 'EPIC';
    }
    if (roll < RARITY_CONFIG.RARE.threshold) {
      return 'RARE';
    }
    return null;
  }

  /**
   * Get public state (safe to return to client)
   */
  getPublicState(state) {
    return {
      bitsSinceLastCheck: state.bitsSinceLastCheck,
      bitsUntilEligible: state.bitsUntilEligible,
      totalBitsContributed: state.totalBitsContributed,
      totalChecks: state.totalChecks,
      totalHits: state.totalHits,
      nextMilestoneAt: MILESTONE_BITS,
      lastCheckAt: state.lastCheckAt,
      lastHitAt: state.lastHitAt
    };
  }

  /**
   * Get user's luck history
   */
  async getUserLuckHistory(userId, limit = 20) {
    const LuckEvent = getLuckEventModel();
    return LuckEvent.getRecentByUser(userId, limit);
  }

  /**
   * Get global luck statistics
   */
  async getGlobalStats() {
    const LuckEvent = getLuckEventModel();
    const tierStats = await LuckEvent.getGlobalStats();
    const totalEvents = await LuckEvent.countDocuments();

    return {
      totalEvents,
      byTier: tierStats,
      config: {
        milestoneBits: MILESTONE_BITS,
        rarities: Object.fromEntries(
          Object.entries(RARITY_CONFIG).map(([tier, cfg]) => [
            tier,
            { odds: cfg.odds, ggEmission: cfg.ggEmission, points: cfg.governancePoints }
          ])
        )
      }
    };
  }

  /**
   * Get governance leaderboard
   */
  async getGovernanceLeaderboard(limit = 20) {
    if (!this.User) {
      return [];
    }
    return this.User.find({ totalLuckHits: { $gt: 0 } })
      .sort({ gluckScore: -1 })
      .limit(limit)
      .select('firstName lastName email gluckScore totalLuckHits luckHits');
  }

  /**
   * Test endpoint - trigger luck check with forced values
   */
  async testTriggerLuck(userId, options = {}) {
    const LuckEvent = getLuckEventModel();
    const { forceTier, forceRoll, useRealDraw = false, gameContext = 'test-trigger' } = options;
    const minerId = userId.toString();

    let draw;
    let rollValue;

    if (forceRoll !== undefined) {
      // Use forced roll value
      rollValue = forceRoll;
      draw = {
        drawId: `test-forced-${Date.now()}`,
        entropy: rollValue.toString(16).padStart(8, '0') + crypto.randomBytes(4).toString('hex'),
        source: 'test-forced'
      };
    } else if (forceTier) {
      // Force specific tier by setting roll to hit that tier
      const tierRolls = {
        LEGENDARY: 0,
        EPIC: 5,
        RARE: 50
      };
      rollValue = tierRolls[forceTier] ?? 50;
      draw = {
        drawId: `test-tier-${Date.now()}`,
        entropy: rollValue.toString(16).padStart(8, '0') + crypto.randomBytes(4).toString('hex'),
        source: 'test-tier'
      };
    } else if (useRealDraw) {
      // Actually draw from pool
      draw = await this.drawEntropyFromArca(minerId, gameContext);
      rollValue = this.entropyToRoll(draw.entropy);
    } else {
      // Use local RNG
      draw = this.localEntropyFallback(minerId);
      rollValue = this.entropyToRoll(draw.entropy);
    }

    const rarityTier = this.determineRarity(rollValue);

    if (!rarityTier) {
      return {
        hit: false,
        rollValue,
        draw,
        message: `No hit (roll ${rollValue} >= 100 threshold for RARE)`
      };
    }

    // Create actual luck event
    const config = RARITY_CONFIG[rarityTier];
    const eventId = `luck-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const luckEvent = await LuckEvent.create({
      userId,
      eventId,
      rarityTier,
      ggEmission: config.ggEmission,
      governancePoints: config.governancePoints,
      rollValue,
      threshold: config.threshold,
      arcaDrawId: draw.drawId,
      entropyHex: draw.entropy,
      gameContext,
      payoutStatus: 'pending'
    });

    // Update user stats
    if (this.User) {
      await this.User.findByIdAndUpdate(userId, {
        $inc: {
          gluckScore: config.governancePoints,
          totalLuckHits: 1,
          [`luckHits.${rarityTier}`]: 1
        }
      });
    }

    return {
      hit: true,
      proof: {
        eventId,
        rarityTier,
        rarityName: config.name,
        rollValue,
        threshold: config.threshold,
        ggEmission: config.ggEmission,
        governancePoints: config.governancePoints
      },
      draw
    };
  }
}

// Export singleton
module.exports = new LuckService();
