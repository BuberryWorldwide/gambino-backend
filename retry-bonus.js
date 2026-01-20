require("dotenv").config();
const mongoose = require("mongoose");

// Load schemas from server.js by requiring necessary parts
async function retryBonus() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/gambino");
  
  // Define a simple User schema to query
  const userSchema = new mongoose.Schema({}, { strict: false, collection: 'users' });
  const User = mongoose.model("User", userSchema);
  
  const user = await User.findOne({ email: "test@disbursement.com" });
  
  if (!user) {
    console.log("User not found");
    process.exit(1);
  }
  
  console.log("Found user:", user.email, "wallet:", user.walletAddress);
  console.log("referredBy:", user.referredBy);
  
  const BonusDisbursementService = require("./src/services/bonusDisbursementService");
  const bonusService = new BonusDisbursementService();
  
  console.log("Attempting bonus disbursement...");
  
  const result = await bonusService.disburseSignupBonus({
    userId: user._id,
    walletAddress: user.walletAddress,
    email: user.email,
    referralInfo: {
      referrerId: user.referredBy,
      referralCode: null
    }
  });
  
  console.log("Bonus result:", JSON.stringify(result, null, 2));
  await mongoose.disconnect();
  process.exit(0);
}

retryBonus().catch(e => { console.error(e); process.exit(1); });
