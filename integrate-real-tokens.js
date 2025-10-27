// Add real GAMBINO token distribution to user registration
const fs = require('fs');

console.log('🪙 INTEGRATING REAL GAMBINO TOKEN DISTRIBUTION');
console.log('==============================================');

let serverCode = fs.readFileSync('server.js', 'utf8');

// Add the import at the top
if (!serverCode.includes('GambinoTokenService')) {
  const importLine = `const GambinoTokenService = require('./src/services/gambinoTokenService');\n`;
  serverCode = serverCode.replace(
    "const bcrypt = require('bcryptjs');",
    "const bcrypt = require('bcryptjs');\n" + importLine
  );
}

// Add service initialization
if (!serverCode.includes('const gambinoService')) {
  const serviceInit = `const gambinoService = new GambinoTokenService();\n`;
  serverCode = serverCode.replace(
    "const User = mongoose.model('User', userSchema);",
    "const User = mongoose.model('User', userSchema);\n" + serviceInit
  );
}

// Replace the TODO comment with actual token distribution
const oldTodo = `    // TODO: Send real GAMBINO tokens from treasury
    console.log('💰 User created with real wallet:', user.walletAddress);
    console.log('🎁 Database balance:', tokens, 'GAMBINO');
    console.log('⚠️ TODO: Send real blockchain tokens from Community Rewards treasury');`;

const newTokenDistribution = `    // Send real GAMBINO tokens from Community Rewards treasury
    console.log('💰 User created with real wallet:', user.walletAddress);
    console.log('🎁 Sending', tokens, 'GAMBINO tokens from treasury...');
    
    try {
      const rewardResult = await gambinoService.distributeRegistrationReward(
        user._id,
        user.walletAddress,
        'userRegistration'
      );
      
      if (rewardResult.success) {
        console.log('✅ Sent', rewardResult.amount, 'GAMBINO tokens to', user.walletAddress);
        console.log('🔗 Transaction:', rewardResult.transaction);
      } else {
        console.error('❌ Failed to send tokens:', rewardResult.error);
        // Don't fail registration if token distribution fails
      }
    } catch (tokenError) {
      console.error('❌ Token distribution error:', tokenError.message);
      // Continue with registration even if token transfer fails
    }`;

// Make the replacement
const fixedCode = serverCode.replace(oldTodo, newTokenDistribution);

// Backup and write
fs.writeFileSync('server.js.backup-before-real-tokens', serverCode);
fs.writeFileSync('server.js', fixedCode);

console.log('✅ Integrated real GAMBINO token distribution');
console.log('🔄 Restart server to apply changes');
console.log('🎁 New users will now receive real blockchain tokens!');
