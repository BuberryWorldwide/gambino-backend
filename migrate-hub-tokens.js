const mongoose = require('mongoose');
require('dotenv').config();

async function migrateHubTokens() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino');
    console.log('✅ Connected to MongoDB');

    const Hub = require('./src/models/Hub');
    
    // Find pi-2 hub
    const hub = await Hub.findOne({ hubId: 'pi-2-nimbus-1' });
    
    if (!hub) {
      console.log('❌ Hub pi-2-nimbus-1 not found');
      process.exit(1);
    }

    console.log(`Found hub: ${hub.hubId}`);

    // Generate tokens if they don't exist
    if (!hub.accessToken || !hub.refreshToken) {
      const tokens = hub.generateTokens();
      await hub.save();
      
      console.log('\n✅ Tokens generated successfully!');
      console.log('Hub ID:', hub.hubId);
      console.log('Access Token:', tokens.accessToken);
      console.log('Refresh Token:', tokens.refreshToken);
      console.log('Expires At:', tokens.expiresAt);
      console.log('\n📝 Save these tokens for the Pi:');
      console.log(`MACHINE_TOKEN=${tokens.accessToken}`);
      console.log(`REFRESH_TOKEN=${tokens.refreshToken}`);
    } else {
      console.log('✅ Hub already has tokens');
      console.log('Access Token expires:', hub.accessTokenExpiresAt);
      console.log('Refresh Token expires:', hub.refreshTokenExpiresAt);
    }

    await mongoose.disconnect();
    console.log('\n✅ Migration complete');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateHubTokens();
