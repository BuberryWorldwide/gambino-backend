#!/usr/bin/env node
/**
 * Seed script to initialize exchange rate configuration
 * Run this once to set up the initial exchange rate config
 *
 * Usage: node seed-exchange-rate.js
 */

require('dotenv').config({ path: '/opt/gambino/.env' });
const mongoose = require('mongoose');
const ExchangeRateConfig = require('./src/models/ExchangeRateConfig');

async function seedExchangeRate() {
  try {
    console.log('🌱 Seeding exchange rate configuration...');

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');

    // Check if config already exists
    const existingConfig = await ExchangeRateConfig.getCurrentConfig();

    if (existingConfig) {
      console.log('⚠️  Exchange rate config already exists:');
      console.log(JSON.stringify(existingConfig, null, 2));
      console.log('\nSkipping seed. If you want to create a new config, use the admin API.');
      await mongoose.connection.close();
      return;
    }

    // Create initial exchange rate config
    const config = new ExchangeRateConfig({
      tokensPerDollar: 1000, // 1000 tokens = $1 USD
      minCashout: 5, // Minimum $5 cashout
      maxCashoutPerTransaction: 500, // Maximum $500 per transaction
      dailyLimitPerCustomer: 1000, // $1000 per day per customer
      dailyLimitPerStaff: 5000, // $5000 per day per staff member
      venueCommissionPercent: 0, // 0% commission (no fee on cashouts)
      isActive: true,
      effectiveFrom: new Date(),
      notes: 'Initial exchange rate configuration'
    });

    await config.save();

    console.log('✅ Exchange rate config created successfully:');
    console.log('');
    console.log('  Tokens per Dollar: 1000 tokens = $1.00');
    console.log('  Minimum Cashout: $5.00');
    console.log('  Maximum per Transaction: $500.00');
    console.log('  Daily Limit per Customer: $1,000.00');
    console.log('  Daily Limit per Staff: $5,000.00');
    console.log('  Venue Commission: 0%');
    console.log('');
    console.log('🎉 Seeding complete!');

    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('❌ Seeding error:', error);
    process.exit(1);
  }
}

// Run the seed
seedExchangeRate();
