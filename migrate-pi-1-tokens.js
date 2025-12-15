const mongoose = require('mongoose');
require('dotenv').config();

async function migrateHubTokens() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino');
    console.log('✅ Connected to MongoDB');

    const Hub = require('./src/models/Hub');

    // Find pi-1 hub
    const hub = await Hub.findOne({ hubId: 'pi-1' });
    
    if (!hub) {
      console.log('❌ Hub pi-1 not found');
      process.exit(1);
    }

    console.log(`Found hub: ${hub.hubId}`);

    // Generate tokens (force regeneration)
    const tokens = hub.generateTokens();
    await hub.save();
    
    console.log('\n✅ Tokens generated successfully!');
    console.log('Hub ID:', hub.hubId);
    console.log('Access Token:', tokens.accessToken);
    console.log('Refresh Token:', tokens.refreshToken);
    console.log('Access Token Expires At:', tokens.expiresAt);
    console.log('Refresh Token Expires:', hub.refreshTokenExpiresAt);
    console.log('\n📝 Save these tokens for the Pi:');
    console.log(`MACHINE_TOKEN=${tokens.accessToken}`);
    console.log(`REFRESH_TOKEN=${tokens.refreshToken}`);

    await mongoose.disconnect();
    console.log('\n✅ Migration complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateHubTokens();
