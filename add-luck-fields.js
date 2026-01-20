// Script to add luck fields to User.js model
const fs = require('fs');

const userPath = '/opt/gambino/backend/src/models/User.js';
const backupPath = `/opt/gambino/backend/src/models/User.js.backup-luck-${Date.now()}`;

// Read User.js
let content = fs.readFileSync(userPath, 'utf8');

// Create backup
fs.writeFileSync(backupPath, content);
console.log(`Backup created: ${backupPath}`);

// Check if luck fields already exist
if (content.includes('totalLuckHits')) {
  console.log('Luck fields already exist in User.js');
  process.exit(0);
}

// The luck fields to add after gluckScore
const luckFields = `
  // Proof of Luck Stats
  totalLuckHits: { type: Number, default: 0, min: 0 },
  luckHits: {
    RARE: { type: Number, default: 0 },
    EPIC: { type: Number, default: 0 },
    LEGENDARY: { type: Number, default: 0 }
  },
`;

// Find gluckScore line and add after it
const gluckScoreLine = "gluckScore: { type: Number, default: 0, min: 0 },";

if (!content.includes(gluckScoreLine)) {
  console.error('Could not find gluckScore field in User.js');
  process.exit(1);
}

// Insert luck fields after gluckScore
content = content.replace(gluckScoreLine, gluckScoreLine + luckFields);

// Write updated User.js
fs.writeFileSync(userPath, content);
console.log('✅ Luck fields added to User.js');
