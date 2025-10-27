const mongoose = require('mongoose');
const DeviceSchema = new mongoose.Schema({
  device_id:  { type: String, unique: true, index: true },
  secret:     { type: String, required: true },
  machine_id: { type: String }, // bind after claim
  store_id:   { type: String },
  active:     { type: Boolean, default: true },
  lastSeenAt: { type: Date }
}, { collection: 'devices' });

module.exports = mongoose.model('Device', DeviceSchema);
