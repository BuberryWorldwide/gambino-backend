#!/usr/bin/env node

/**
 * RBAC Migration Test & Validation Script
 * Tests the migrated RBAC system to ensure everything works correctly
 * 
 * Usage: node test-rbac-migration.js [--create-users] [--test-all] [--cleanup]
 */

const axios = require('axios');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
require('dotenv').config();

// Configuration
const CONFIG = {
  baseURL: process.env.TEST_BASE_URL || 'http://localhost:3001',
  mongoURI: process.env.MONGODB_URI || 'mongodb://localhost:27017/gambino',
  createTestUsers: process.argv.includes('--create-users'),
  testAll: process.argv.includes('--test-all') || true,
  cleanup: process.argv.includes('--cleanup'),
  verbose: process.argv.includes('--verbose')
};

// Test users for different roles
const TEST_USERS = {
  super_admin: {
    email: 'superadmin@test.gambino.com',
    password: 'TestPass123!',
    role: 'super_admin',
    firstName: 'Super',
    lastName: 'Admin'
  },
  gambino_ops: {
    email: 'ops@test.gambino.com', 
    password: 'TestPass123!',
    role: 'gambino_ops',
    firstName: 'Operations',
    lastName: 'Manager'
  },
  venue_manager: {
    email: 'venuemanager@test.gambino.com',
    password: 'TestPass123!',
    role: 'venue_manager',
    firstName: 'Venue',
    lastName: 'Manager',
    assignedVenues: ['TEST_STORE_001', 'TEST_STORE_002']
  },
  venue_staff: {
    email: 'venuestaff@test.gambino.com',
    password: 'TestPass123!', 
    role: 'venue_staff',
    firstName: 'Venue',
    lastName: 'Staff',
    assignedVenues: ['TEST_STORE_001']
  },
  user: {
    email: 'player@test.gambino.com',
    password: 'TestPass123!',
    role: 'user',
    firstName: 'Test',
    lastName: 'Player'
  }
};

// Test scenarios
const TEST_SCENARIOS = [
  {
    name: 'Authentication Tests',
    tests: [
      { name: 'Valid login', endpoint: '/api/auth/login', method: 'POST' },
      { name: 'Invalid credentials', endpoint: '/api/auth/login', method: 'POST', expectFail: true },
      { name: 'Profile access', endpoint: '/api/auth/profile', method: 'GET' },
      { name: 'Token refresh', endpoint: '/api/auth/refresh', method: 'POST' }
    ]
  },
  {
    name: 'User Management Tests',
    tests: [
      { name: 'View users', endpoint: '/api/admin/users', method: 'GET', roles: ['super_admin', 'gambino_ops'] },
      { name: 'Create user', endpoint: '/api/admin/users', method: 'POST', roles: ['super_admin'] },
      { name: 'Update user', endpoint: '/api/admin/users/{{userId}}', method: 'PUT', roles: ['super_admin', 'gambino_ops'] }
    ]
  },
  {
    name: 'Store Management Tests', 
    tests: [
      { name: 'View all stores', endpoint: '/api/admin/stores', method: 'GET', roles: ['super_admin', 'gambino_ops'] },
      { name: 'View specific store', endpoint: '/api/admin/stores/TEST_STORE_001', method: 'GET', roles: ['super_admin', 'gambino_ops', 'venue_manager', 'venue_staff'] },
      { name: 'Update store', endpoint: '/api/admin/stores/TEST_STORE_001', method: 'PUT', roles: ['super_admin', 'gambino_ops', 'venue_manager'] },
      { name: 'Create store', endpoint: '/api/admin/stores/create', method: 'POST', roles: ['super_admin', 'venue_manager'] }
    ]
  },
  {
    name: 'Metrics & Analytics Tests',
    tests: [
      { name: 'System metrics', endpoint: '/api/admin/metrics', method: 'GET', roles: ['super_admin', 'gambino_ops'] },
      { name: 'Store wallet', endpoint: '/api/admin/wallet/TEST_STORE_001', method: 'GET', roles: ['super_admin', 'gambino_ops', 'venue_manager'] }
    ]
  },
  {
    name: 'Venue Access Tests',
    tests: [
      { name: 'Assigned venue access', endpoint: '/api/admin/stores/TEST_STORE_001', method: 'GET', roles: ['venue_manager', 'venue_staff'], venueSpecific: true },
      { name: 'Non-assigned venue blocked', endpoint: '/api/admin/stores/TEST_STORE_999', method: 'GET', roles: ['venue_manager', 'venue_staff'], expectFail: true }
    ]
  }
];

class RBACTester {
  constructor() {
    this.results = [];
    this.userTokens = {};
    this.User = null;
    this.Store = null;
  }

  async log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    
    if (level === 'error' || CONFIG.verbose) {
      console.log(prefix, message, ...args);
    }
    
    if (level === 'info') {
      console.log(message, ...args);
    }
  }

  async connectDB() {
    try {
      await mongoose.connect(CONFIG.mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      
      // Define schemas for testing
      const userSchema = new mongoose.Schema({
        firstName: String,
        lastName: String,
        email: { type: String, unique: true, lowercase: true },
        password: { type: String, select: false },
        role: { type: String, enum: ['user', 'venue_staff', 'venue_manager', 'gambino_ops', 'super_admin'], default: 'user' },
        assignedVenues: { type: [String], default: [] },
        isActive: { type: Boolean, default: true },
        lastActivity: { type: Date, default: Date.now }
      }, { collection: 'users' });

      const storeSchema = new mongoose.Schema({
        storeId: { type: String, unique: true },
        storeName: String,
        city: String,
        state: String,
        status: { type: String, default: 'active' },
        createdAt: { type: Date, default: Date.now }
      }, { collection: 'stores' });

      this.User = mongoose.model('TestUser', userSchema);
      this.Store = mongoose.model('TestStore', storeSchema);
      
      await this.log('info', '✅ Connected to database');
      return true;
    } catch (error) {
      await this.log('error', '❌ Database connection failed:', error.message);
      return false;
    }
  }

  async createTestUsers() {
    await this.log('info', '👤 Creating test users...');
    
    for (const [roleName, userData] of Object.entries(TEST_USERS)) {
      try {
        // Check if user already exists
        const existingUser = await this.User.findOne({ email: userData.email });
        
        if (existingUser) {
          await this.log('info', `⚠️ User already exists: ${userData.email}`);
          continue;
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        
        // Create user
        const newUser = await this.User.create({
          ...userData,
          password: hashedPassword
        });
        
        await this.log('info', `✅ Created test user: ${userData.email} (${userData.role})`);
        
      } catch (error) {
        await this.log('error', `❌ Failed to create user ${userData.email}:`, error.message);
      }
    }
  }

  async createTestStores() {
    await this.log('info', '🏪 Creating test stores...');
    
    const testStores = [
      { storeId: 'TEST_STORE_001', storeName: 'Test Store 1', city: 'Las Vegas', state: 'NV' },
      { storeId: 'TEST_STORE_002', storeName: 'Test Store 2', city: 'Reno', state: 'NV' },
      { storeId: 'TEST_STORE_999', storeName: 'Unassigned Store', city: 'Carson City', state: 'NV' }
    ];
    
    for (const storeData of testStores) {
      try {
        const existingStore = await this.Store.findOne({ storeId: storeData.storeId });
        
        if (existingStore) {
          await this.log('info', `⚠️ Store already exists: ${storeData.storeId}`);
          continue;
        }
        
        await this.Store.create(storeData);
        await this.log('info', `✅ Created test store: ${storeData.storeId}`);
        
      } catch (error) {
        await this.log('error', `❌ Failed to create store ${storeData.storeId}:`, error.message);
      }
    }
  }

  async loginUsers() {
    await this.log('info', '🔑 Logging in test users...');
    
    for (const [roleName, userData] of Object.entries(TEST_USERS)) {
      try {
        const response = await axios.post(`${CONFIG.baseURL}/api/auth/login`, {
          email: userData.email,
          password: userData.password
        });
        
        if (response.data.success && response.data.token) {
          this.userTokens[roleName] = response.data.token;
          await this.log('info', `✅ Logged in: ${roleName}`);
        } else {
          await this.log('error', `❌ Login failed for ${roleName}:`, response.data.error);
        }
        
      } catch (error) {
        await this.log('error', `❌ Login error for ${roleName}:`, error.response?.data?.error || error.message);
      }
    }
  }

  async testEndpoint(test, userRole, token) {
    try {
      const config = {
        method: test.method,
        url: `${CONFIG.baseURL}${test.endpoint}`,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      };
      
      // Add test data for POST/PUT requests
      if (test.method === 'POST' || test.method === 'PUT') {
        config.data = this.getTestData(test.endpoint, test.method);
      }
      
      const response = await axios(config);
      
      return {
        success: true,
        status: response.status,
        data: response.data,
        role: userRole
      };
      
    } catch (error) {
      return {
        success: false,
        status: error.response?.status || 0,
        error: error.response?.data?.error || error.message,
        code: error.response?.data?.code,
        role: userRole
      };
    }
  }

  getTestData(endpoint, method) {
    if (endpoint.includes('/users') && method === 'POST') {
      return {
        email: `test_${Date.now()}@example.com`,
        password: 'TempPass123!',
        firstName: 'Test',
        lastName: 'User',
        role: 'user'
      };
    }
    
    if (endpoint.includes('/users') && method === 'PUT') {
      return {
        firstName: 'Updated',
        lastName: 'Name'
      };
    }
    
    if (endpoint.includes('/stores/create')) {
      return {
        storeId: `TEST_${Date.now()}`,
        storeName: 'Test Store',
        city: 'Test City',
        state: 'TS'
      };
    }
    
    if (endpoint.includes('/stores') && method === 'PUT') {
      return {
        storeName: 'Updated Store Name'
      };
    }
    
    return {};
  }

  async runTestScenario(scenario) {
    await this.log('info', `\n📋 Running: ${scenario.name}`);
    
    for (const test of scenario.tests) {
      await this.log('info', `  🔍 Testing: ${test.name}`);
      
      // Determine which roles should have access
      const testRoles = test.roles || Object.keys(TEST_USERS);
      
      for (const [roleName, userData] of Object.entries(TEST_USERS)) {
        const shouldHaveAccess = testRoles.includes(userData.role);
        const token = this.userTokens[roleName];
        
        if (!token) {
          await this.log('error', `    ❌ No token for ${roleName}`);
          continue;
        }
        
        // Handle venue-specific tests
        if (test.venueSpecific && userData.role === 'venue_staff' && 
            test.endpoint.includes('TEST_STORE_002')) {
          // venue_staff should not access TEST_STORE_002 (not assigned)
          shouldHaveAccess = false;
        }
        
        const result = await this.testEndpoint(test, userData.role, token);
        
        // Evaluate result
        const passed = test.expectFail ? 
          (!result.success && (result.status === 403 || result.status === 401)) :
          (shouldHaveAccess ? result.success : !result.success);
        
        const status = passed ? '✅' : '❌';
        await this.log('info', `    ${status} ${roleName}: ${result.success ? 'SUCCESS' : `FAIL (${result.status})`}`);
        
        if (!passed && CONFIG.verbose) {
          await this.log('error', `      Expected: ${shouldHaveAccess ? 'SUCCESS' : 'FAIL'}, Got: ${result.success ? 'SUCCESS' : 'FAIL'}`);
          await this.log('error', `      Error: ${result.error}`);
        }
        
        this.results.push({
          scenario: scenario.name,
          test: test.name,
          role: userData.role,
          expected: shouldHaveAccess,
          actual: result.success,
          passed,
          status: result.status,
          error: result.error
        });
      }
    }
  }

  async runAllTests() {
    await this.log('info', '🚀 Starting RBAC migration tests...\n');
    
    // Login all users first
    await this.loginUsers();
    
    // Run test scenarios
    for (const scenario of TEST_SCENARIOS) {
      await this.runTestScenario(scenario);
    }
    
    // Generate report
    await this.generateReport();
  }

  async generateReport() {
    await this.log('info', '\n📊 Test Results Summary');
    await this.log('info', '========================');
    
    const totalTests = this.results.length;
    const passedTests = this.results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    
    await this.log('info', `Total Tests: ${totalTests}`);
    await this.log('info', `Passed: ${passedTests} (${((passedTests/totalTests)*100).toFixed(1)}%)`);
    await this.log('info', `Failed: ${failedTests} (${((failedTests/totalTests)*100).toFixed(1)}%)`);
    
    if (failedTests > 0) {
      await this.log('info', '\n❌ Failed Tests:');
      const failures = this.results.filter(r => !r.passed);
      
      failures.forEach(failure => {
        this.log('info', `  - ${failure.scenario} > ${failure.test} > ${failure.role}`);
        this.log('info', `    Expected: ${failure.expected ? 'PASS' : 'FAIL'}, Got: ${failure.actual ? 'PASS' : 'FAIL'}`);
        if (failure.error) {
          this.log('info', `    Error: ${failure.error}`);
        }
      });
    }
    
    // Generate detailed report by role
    await this.log('info', '\n📋 Results by Role:');
    Object.keys(TEST_USERS).forEach(role => {
      const roleResults = this.results.filter(r => r.role === role);
      const rolePassed = roleResults.filter(r => r.passed).length;
      const percentage = ((rolePassed / roleResults.length) * 100).toFixed(1);
      
      this.log('info', `  ${role}: ${rolePassed}/${roleResults.length} (${percentage}%)`);
    });
    
    return {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      percentage: (passedTests/totalTests)*100
    };
  }

  async cleanupTestData() {
    if (!CONFIG.cleanup) return;
    
    await this.log('info', '\n🧹 Cleaning up test data...');
    
    try {
      // Remove test users
      const deleteUserResult = await this.User.deleteMany({ 
        email: { $in: Object.values(TEST_USERS).map(u => u.email) } 
      });
      await this.log('info', `✅ Removed ${deleteUserResult.deletedCount} test users`);
      
      // Remove test stores
      const deleteStoreResult = await this.Store.deleteMany({ 
        storeId: { $regex: '^TEST_' } 
      });
      await this.log('info', `✅ Removed ${deleteStoreResult.deletedCount} test stores`);
      
    } catch (error) {
      await this.log('error', '❌ Cleanup error:', error.message);
    }
  }

  async disconnect() {
    await mongoose.disconnect();
    await this.log('info', '✅ Disconnected from database');
  }
}

// Health check function
async function healthCheck() {
  try {
    const response = await axios.get(`${CONFIG.baseURL}/health`);
    console.log('✅ Server is running:', response.data);
    return true;
  } catch (error) {
    console.log('❌ Server health check failed:', error.message);
    console.log('   Make sure your server is running on', CONFIG.baseURL);
    return false;
  }
}

// Main execution
async function main() {
  console.log('🧪 RBAC Migration Test Suite');
  console.log('============================\n');
  
  // Health check
  const serverHealthy = await healthCheck();
  if (!serverHealthy) {
    process.exit(1);
  }
  
  const tester = new RBACTester();
  
  try {
    // Connect to database
    const dbConnected = await tester.connectDB();
    if (!dbConnected) {
      process.exit(1);
    }
    
    // Create test data
    if (CONFIG.createTestUsers) {
      await tester.createTestUsers();
      await tester.createTestStores();
    }
    
    // Run tests
    await tester.runAllTests();
    
    // Cleanup
    await tester.cleanupTestData();
    
    console.log('\n🎉 Test suite completed!');
    console.log('\n💡 Next Steps:');
    console.log('   1. Review any failed tests above');  
    console.log('   2. Check server logs for detailed error information');
    console.log('   3. Update permissions or fix issues as needed');
    console.log('   4. Re-run tests after fixes');
    
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
    process.exit(1);
  } finally {
    await tester.disconnect();
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { RBACTester, healthCheck, TEST_USERS, TEST_SCENARIOS };
