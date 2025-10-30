const fs = require('fs');
const crypto = require('crypto');

const hubModelPath = './src/models/Hub.js';
let content = fs.readFileSync(hubModelPath, 'utf8');

// Token management methods to add before module.exports
const tokenMethods = `

// ============================================================================
// TOKEN MANAGEMENT METHODS (Auto-Renewal System)
// ============================================================================

// Generate new access + refresh tokens
hubSchema.methods.generateTokens = function() {
  const jwt = require('jsonwebtoken');
  const crypto = require('crypto');
  
  // Short-lived access token (7 days)
  this.accessToken = jwt.sign(
    {
      hubId: this.hubId,
      storeId: this.storeId,
      type: 'hub',
      tokenVersion: this.tokenVersion,
      iat: Math.floor(Date.now() / 1000)
    },
    process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  this.accessTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  // Long-lived refresh token (1 year)
  this.refreshToken = crypto.randomBytes(32).toString('hex');
  this.refreshTokenExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  
  this.lastTokenRefresh = new Date();
  this.tokenRefreshCount += 1;
  
  console.log(\`🔑 Generated tokens for hub \${this.hubId} (version \${this.tokenVersion})\`);
  
  return {
    accessToken: this.accessToken,
    refreshToken: this.refreshToken,
    expiresAt: this.accessTokenExpiresAt,
    expiresIn: 7 * 24 * 60 * 60 // seconds
  };
};

// Refresh access token using refresh token
hubSchema.methods.refreshAccessToken = function() {
  const jwt = require('jsonwebtoken');
  
  // Check if refresh token is still valid
  if (this.refreshTokenExpiresAt < new Date()) {
    throw new Error('Refresh token expired');
  }
  
  // Generate new access token
  this.accessToken = jwt.sign(
    {
      hubId: this.hubId,
      storeId: this.storeId,
      type: 'hub',
      tokenVersion: this.tokenVersion,
      iat: Math.floor(Date.now() / 1000)
    },
    process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  this.accessTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  this.lastTokenRefresh = new Date();
  this.tokenRefreshCount += 1;
  
  console.log(\`🔄 Refreshed access token for hub \${this.hubId}\`);
  
  return {
    accessToken: this.accessToken,
    expiresAt: this.accessTokenExpiresAt,
    expiresIn: 7 * 24 * 60 * 60
  };
};

// Revoke all tokens (increment version)
hubSchema.methods.revokeTokens = function(reason = 'manual_revocation') {
  this.tokenVersion += 1;
  this.accessToken = null;
  this.refreshToken = null;
  this.accessTokenExpiresAt = null;
  this.refreshTokenExpiresAt = null;
  
  console.log(\`🚫 Revoked tokens for hub \${this.hubId} - Reason: \${reason}\`);
  
  return this.tokenVersion;
};

// Check if access token needs refresh (expires in < 24 hours)
hubSchema.methods.needsRefresh = function() {
  if (!this.accessTokenExpiresAt) return true;
  const hoursUntilExpiry = (this.accessTokenExpiresAt - Date.now()) / (1000 * 60 * 60);
  return hoursUntilExpiry < 24;
};

// Static method: Find hub by refresh token
hubSchema.statics.findByRefreshToken = function(refreshToken) {
  return this.findOne({ 
    refreshToken,
    refreshTokenExpiresAt: { $gt: new Date() }
  });
};

// Static method: Clean up expired tokens (for cron job)
hubSchema.statics.cleanupExpiredTokens = async function() {
  const result = await this.updateMany(
    { refreshTokenExpiresAt: { $lt: new Date() } },
    { 
      $set: { 
        accessToken: null, 
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null
      } 
    }
  );
  console.log(\`🧹 Cleaned up \${result.modifiedCount} expired tokens\`);
  return result.modifiedCount;
};
`;

// Add before module.exports
content = content.replace(
  /module\.exports = mongoose\.model/,
  tokenMethods + '\nmodule.exports = mongoose.model'
);

fs.writeFileSync(hubModelPath, content);
console.log('✅ Added token management methods to Hub model');
