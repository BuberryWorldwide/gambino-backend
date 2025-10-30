#!/usr/bin/env node
/**
 * DIAGNOSTIC SCRIPT: Investigate Duplicate Daily Reports
 * 
 * This script helps you understand why the dashboard shows inflated numbers.
 * It will:
 * 1. Connect to your MongoDB database
 * 2. Find all dates with multiple "included" daily reports
 * 3. Show the totals that are causing inflation
 * 4. Generate a report of what needs to be fixed
 * 
 * USAGE:
 * 1. Copy this file to your backend server
 * 2. Run: node investigate-duplicates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

// ============================================================================
// CONFIGURATION
// ============================================================================

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino';

// ============================================================================
// CONNECT TO DATABASE
// ============================================================================

async function connect() {
  console.log('🔌 Connecting to MongoDB...');
  console.log(`   URI: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}\n`);
  
  await mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  
  console.log('✅ Connected!\n');
}

// ============================================================================
// DEFINE MODELS
// ============================================================================

const DailyReportSchema = new mongoose.Schema({
  storeId: String,
  reportDate: Date,
  printedAt: Date,
  totalMoneyIn: Number,
  totalRevenue: Number,
  totalCollect: Number,
  reconciliationStatus: String,
  machineData: Array,
  machineCount: Number
}, { collection: 'dailyreports' });

const EventSchema = new mongoose.Schema({
  storeId: String,
  eventType: String,
  amount: Number,
  timestamp: Date,
  gamingMachineId: String
}, { collection: 'events' });

const DailyReport = mongoose.model('DailyReport', DailyReportSchema);
const Event = mongoose.model('Event', EventSchema);

// ============================================================================
// INVESTIGATION FUNCTIONS
// ============================================================================

async function findDuplicateReports() {
  console.log('==========================================');
  console.log('🔍 SEARCHING FOR DUPLICATE DAILY REPORTS');
  console.log('==========================================\n');
  
  // Find all dates with multiple "included" reports
  const duplicates = await DailyReport.aggregate([
    {
      $match: {
        reconciliationStatus: 'included'
      }
    },
    {
      $group: {
        _id: {
          storeId: '$storeId',
          date: { $dateToString: { format: "%Y-%m-%d", date: "$reportDate" } }
        },
        count: { $sum: 1 },
        reports: { 
          $push: { 
            id: '$_id',
            printedAt: '$printedAt',
            totalMoneyIn: '$totalMoneyIn',
            totalRevenue: '$totalRevenue',
            machineCount: '$machineCount'
          } 
        },
        totalMoneyIn: { $sum: '$totalMoneyIn' },
        totalRevenue: { $sum: '$totalRevenue' }
      }
    },
    {
      $match: {
        count: { $gt: 1 }  // Only dates with multiple reports
      }
    },
    {
      $sort: { "_id.date": -1 }
    }
  ]);
  
  if (duplicates.length === 0) {
    console.log('✅ No duplicate reports found! Your data is clean.\n');
    return [];
  }
  
  console.log(`⚠️  Found ${duplicates.length} dates with duplicate reports:\n`);
  
  let totalInflation = 0;
  
  for (const dup of duplicates) {
    const { storeId, date } = dup._id;
    const reports = dup.reports.sort((a, b) => 
      new Date(b.printedAt) - new Date(a.printedAt)
    );
    
    const latestReport = reports[0];
    const sumOfAll = dup.totalMoneyIn;
    const inflation = sumOfAll - latestReport.totalMoneyIn;
    totalInflation += inflation;
    
    console.log(`📅 Date: ${date}`);
    console.log(`   Store: ${storeId}`);
    console.log(`   Reports: ${dup.count}`);
    console.log(`   CURRENT DASHBOARD (summing all): $${sumOfAll.toFixed(2)}`);
    console.log(`   CORRECT VALUE (latest only): $${latestReport.totalMoneyIn.toFixed(2)}`);
    console.log(`   INFLATION: $${inflation.toFixed(2)} 💥\n`);
    
    console.log(`   Latest Report Details:`);
    console.log(`      ID: ${latestReport.id}`);
    console.log(`      Printed: ${new Date(latestReport.printedAt).toLocaleString()}`);
    console.log(`      Machines: ${latestReport.machineCount}`);
    console.log(`      Money IN: $${latestReport.totalMoneyIn.toFixed(2)}`);
    
    if (reports.length > 1) {
      console.log(`\n   Duplicate Reports (should be marked as 'duplicate'):`);
      for (let i = 1; i < reports.length; i++) {
        const rep = reports[i];
        console.log(`      ${i}. ID: ${rep.id}`);
        console.log(`         Printed: ${new Date(rep.printedAt).toLocaleString()}`);
        console.log(`         Money IN: $${rep.totalMoneyIn.toFixed(2)}`);
      }
    }
    
    console.log('\n   ─────────────────────────────────────────\n');
  }
  
  console.log('==========================================');
  console.log(`💥 TOTAL INFLATION: $${totalInflation.toFixed(2)}`);
  console.log('==========================================\n');
  
  return duplicates;
}

async function generateStoreSummary() {
  console.log('==========================================');
  console.log('📊 STORE-LEVEL SUMMARY');
  console.log('==========================================\n');
  
  const stores = await DailyReport.distinct('storeId');
  
  for (const storeId of stores) {
    console.log(`\n📍 Store: ${storeId}`);
    console.log('   ─────────────────────────────────────────');
    
    // Count reports by status
    const statusCounts = await DailyReport.aggregate([
      { $match: { storeId: storeId } },
      { 
        $group: { 
          _id: '$reconciliationStatus',
          count: { $sum: 1 },
          totalRevenue: { $sum: '$totalMoneyIn' }
        } 
      }
    ]);
    
    let includedTotal = 0;
    let includedCount = 0;
    
    for (const status of statusCounts) {
      const statusName = status._id || 'undefined';
      console.log(`   ${statusName}: ${status.count} reports ($${status.totalRevenue.toFixed(2)})`);
      
      if (statusName === 'included') {
        includedTotal = status.totalRevenue;
        includedCount = status.count;
      }
    }
    
    // Check for duplicates
    const duplicateDates = await DailyReport.aggregate([
      { 
        $match: { 
          storeId: storeId,
          reconciliationStatus: 'included'
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$reportDate" } },
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      }
    ]);
    
    if (duplicateDates.length > 0) {
      console.log(`\n   ⚠️  ${duplicateDates.length} dates have duplicate 'included' reports`);
      console.log(`   💰 Current Total: $${includedTotal.toFixed(2)} (INFLATED)`);
    } else {
      console.log(`\n   ✅ No duplicates found`);
      console.log(`   💰 Total Revenue: $${includedTotal.toFixed(2)} (ACCURATE)`);
    }
  }
  
  console.log('\n');
}

async function checkRecentActivity() {
  console.log('==========================================');
  console.log('🕐 RECENT ACTIVITY (Last 7 Days)');
  console.log('==========================================\n');
  
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  const recentReports = await DailyReport.aggregate([
    {
      $match: {
        printedAt: { $gte: sevenDaysAgo }
      }
    },
    {
      $group: {
        _id: {
          storeId: '$storeId',
          date: { $dateToString: { format: "%Y-%m-%d", date: "$reportDate" } }
        },
        count: { $sum: 1 },
        statuses: { $push: '$reconciliationStatus' }
      }
    },
    {
      $sort: { "_id.date": -1 }
    }
  ]);
  
  console.log(`Found ${recentReports.length} report groups in the last 7 days:\n`);
  
  for (const group of recentReports) {
    const { storeId, date } = group._id;
    const statusCounts = {};
    
    group.statuses.forEach(status => {
      const s = status || 'undefined';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    
    const statusStr = Object.entries(statusCounts)
      .map(([status, count]) => `${status}:${count}`)
      .join(', ');
    
    const alert = group.count > 1 ? ' ⚠️  MULTIPLE REPORTS' : '';
    
    console.log(`   ${date} - ${storeId}`);
    console.log(`      Reports: ${group.count} (${statusStr})${alert}`);
  }
  
  console.log('\n');
}

async function generateFixScript(duplicates) {
  console.log('==========================================');
  console.log('🔧 FIX SCRIPT GENERATED');
  console.log('==========================================\n');
  
  if (duplicates.length === 0) {
    console.log('✅ No fixes needed - data is clean!\n');
    return;
  }
  
  console.log('Run this MongoDB script to mark duplicates:\n');
  console.log('```javascript');
  
  for (const dup of duplicates) {
    const reports = dup.reports.sort((a, b) => 
      new Date(b.printedAt) - new Date(a.printedAt)
    );
    
    // Keep the latest, mark others as duplicate
    for (let i = 1; i < reports.length; i++) {
      const reportId = reports[i].id;
      console.log(`db.dailyreports.updateOne(`);
      console.log(`  { _id: ObjectId("${reportId}") },`);
      console.log(`  { $set: { reconciliationStatus: 'duplicate', notes: 'Superseded by later report' } }`);
      console.log(`);`);
    }
  }
  
  console.log('```\n');
  
  console.log('Or use the migration function in fixed-financial-summary-endpoint.js\n');
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  try {
    await connect();
    
    // Run all diagnostic functions
    await generateStoreSummary();
    await checkRecentActivity();
    const duplicates = await findDuplicateReports();
    await generateFixScript(duplicates);
    
    console.log('==========================================');
    console.log('✅ DIAGNOSTIC COMPLETE');
    console.log('==========================================\n');
    console.log('NEXT STEPS:');
    console.log('1. Review the duplicate reports above');
    console.log('2. Apply the fix in fixed-financial-summary-endpoint.js');
    console.log('3. Run the migration script to mark duplicates');
    console.log('4. Refresh your dashboard to see corrected numbers\n');
    
  } catch (error) {
    console.error('❌ Error during investigation:', error);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from database\n');
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  findDuplicateReports,
  generateStoreSummary,
  checkRecentActivity
};
