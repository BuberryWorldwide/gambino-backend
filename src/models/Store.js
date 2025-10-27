// src/models/Store.js
const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
  storeId: { type: String, unique: true, sparse: true },
  storeName: String,
  name: String, // legacy alias
  address: String,
  city: String,
  state: String,
  zipCode: String,
  phone: String,
  feePercentage: { type: Number, default: 5, min: 0, max: 100 },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  walletAddress: { type: String, sparse: true },
  machineCount: { type: Number, default: 8 },
  status: { type: String, enum: ['active','inactive','suspended'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'stores' });

module.exports = mongoose.model('Store', StoreSchema);