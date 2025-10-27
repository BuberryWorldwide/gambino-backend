// Add createUserTokenAccount method to GambinoTokenService
const fs = require('fs');

console.log('🔧 ADDING TOKEN ACCOUNT CREATION METHOD');
console.log('======================================');

let serviceCode = fs.readFileSync('src/services/gambinoTokenService.js', 'utf8');

// Find the end of the class (before module.exports)
const moduleExportIndex = serviceCode.indexOf('module.exports = GambinoTokenService;');

if (moduleExportIndex !== -1) {
  const beforeExport = serviceCode.substring(0, moduleExportIndex);
  const afterExport = serviceCode.substring(moduleExportIndex);
  
  // Add the new method before module.exports
  const tokenAccountMethod = `
  // Create token account for a user wallet
  async createUserTokenAccount(userWalletAddress) {
    try {
      console.log('🏗️ Creating token account for wallet:', userWalletAddress);
      
      const userPublicKey = new PublicKey(userWalletAddress);
      const payerKeypair = await this.credentialManager.getKeypair('payer');
      
      if (!payerKeypair.success) {
        throw new Error('Failed to get payer credentials');
      }
      
      // Get or create associated token account
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        this.connection,
        payerKeypair.keypair,
        this.gambinoMint,
        userPublicKey
      );
      
      console.log('✅ Token account created/found:', tokenAccount.address.toString());
      
      return {
        success: true,
        tokenAccount: tokenAccount.address.toString(),
        mint: this.gambinoMint.toString(),
        owner: userWalletAddress
      };
      
    } catch (error) {
      console.error('❌ Token account creation failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

`;

  // Combine everything
  const newServiceCode = beforeExport + tokenAccountMethod + afterExport;
  
  // Backup and write
  fs.writeFileSync('src/services/gambinoTokenService.js.backup-before-token-account', serviceCode);
  fs.writeFileSync('src/services/gambinoTokenService.js', newServiceCode);
  
  console.log('✅ Added createUserTokenAccount method');
  console.log('🔄 Restart server to test token account creation');
} else {
  console.log('❌ Could not find module.exports line');
}
