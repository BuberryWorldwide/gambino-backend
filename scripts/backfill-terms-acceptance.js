/**
 * Migration Script: Backfill termsAccepted for existing users
 *
 * This script adds VDV terms acceptance records to all existing users
 * who were created before the VDV ToS implementation.
 *
 * Run with: node scripts/backfill-terms-acceptance.js
 *
 * The 'migrated: true' flag indicates this was a backfill, not an
 * explicit user acceptance. This allows filtering for re-acceptance
 * prompts if needed in the future.
 */

require('dotenv').config({ path: '/opt/gambino/.env' });
const mongoose = require('mongoose');

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino';

async function backfillTermsAcceptance() {
  console.log('🔧 Connecting to MongoDB...');

  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  console.log('📦 Connected to MongoDB');

  // Use native collection to avoid schema validation issues
  const db = mongoose.connection.db;
  const usersCollection = db.collection('users');

  // Find all users without termsAccepted or with empty termsAccepted array
  const usersToUpdate = await usersCollection.find({
    $or: [
      { termsAccepted: { $exists: false } },
      { termsAccepted: { $size: 0 } }
    ]
  }).toArray();

  console.log(`📊 Found ${usersToUpdate.length} users to backfill`);

  if (usersToUpdate.length === 0) {
    console.log('✅ No users need backfilling');
    await mongoose.disconnect();
    return;
  }

  // Backfill each user
  let successCount = 0;
  let errorCount = 0;

  for (const user of usersToUpdate) {
    try {
      const termsRecord = {
        operatorId: 'vdv',
        version: 'vdv-tos-v1.0-legacy',
        acceptedAt: user.createdAt || new Date('2024-01-01'),
        ipAddress: user.ipAddress || null,
        migrated: true
      };

      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            termsAccepted: [termsRecord]
          }
        }
      );

      successCount++;

      if (successCount % 100 === 0) {
        console.log(`  Progress: ${successCount}/${usersToUpdate.length} users updated`);
      }
    } catch (error) {
      console.error(`❌ Error updating user ${user._id}:`, error.message);
      errorCount++;
    }
  }

  console.log('\n📊 Migration Summary:');
  console.log(`  ✅ Successfully updated: ${successCount} users`);
  console.log(`  ❌ Errors: ${errorCount} users`);
  console.log(`  📝 Terms version: vdv-tos-v1.0-legacy`);
  console.log(`  🏷️ Operator: vdv`);
  console.log(`  🔖 Migrated flag: true`);

  await mongoose.disconnect();
  console.log('\n✅ Migration complete');
}

// Run the migration
backfillTermsAcceptance()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
