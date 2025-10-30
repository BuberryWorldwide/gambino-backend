const fs = require('fs');

const hubModelPath = './src/models/Hub.js';
let content = fs.readFileSync(hubModelPath, 'utf8');

// Add these fields after the existing schema fields (before createdAt)
const tokenFields = `
  // Token Management (Auto-Renewal System)
  accessToken: { 
    type: String, 
    required: true,
    index: true 
  },
  accessTokenExpiresAt: { 
    type: Date, 
    required: true,
    index: true 
  },
  refreshToken: { 
    type: String, 
    required: true,
    unique: true,
    index: true 
  },
  refreshTokenExpiresAt: { 
    type: Date, 
    required: true 
  },
  tokenVersion: { 
    type: Number, 
    default: 1 
  },
  lastTokenRefresh: { type: Date },
  tokenRefreshCount: { type: Number, default: 0 },
`;

// Insert before createdAt field
content = content.replace(
  /createdAt: { type: Date, default: Date\.now }/,
  tokenFields + '\n  createdAt: { type: Date, default: Date.now }'
);

fs.writeFileSync(hubModelPath, content);
console.log('✅ Hub model updated with token management fields');
