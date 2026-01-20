// src/models/Tag.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const tagSchema = new mongoose.Schema({
  token: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  status: { 
    type: String, 
    enum: ['unlinked', 'linked'], 
    default: 'unlinked' 
  },
  machineId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Machine',
    default: null 
  },
  createdAt: { type: Date, default: Date.now },
  linkedAt: { type: Date, default: null },
  linkedBy: { type: String, default: null },
  unlinkHistory: [{
    machineId: mongoose.Schema.Types.ObjectId,
    unlinkedAt: { type: Date, default: Date.now },
    unlinkedBy: String
  }]
});

// Generate a random token like VDV-A7X9K2
tagSchema.statics.generateToken = function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars like 0/O, 1/I/L
  let token = 'VDV-';
  for (let i = 0; i < 6; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

// Generate a batch of unique tokens
tagSchema.statics.generateBatch = async function(count) {
  const tags = [];
  const existingTokens = new Set(
    (await this.find({}, { token: 1 })).map(t => t.token)
  );
  
  while (tags.length < count) {
    const token = this.generateToken();
    if (!existingTokens.has(token)) {
      existingTokens.add(token);
      tags.push({ token, status: 'unlinked' });
    }
  }
  
  return this.insertMany(tags);
};

// Link tag to machine
tagSchema.methods.linkToMachine = async function(machineId, linkedBy) {
  this.machineId = machineId;
  this.status = 'linked';
  this.linkedAt = new Date();
  this.linkedBy = linkedBy || 'system';
  return this.save();
};

// Unlink tag from machine
tagSchema.methods.unlink = async function(unlinkedBy) {
  if (this.machineId) {
    this.unlinkHistory.push({
      machineId: this.machineId,
      unlinkedAt: new Date(),
      unlinkedBy: unlinkedBy || 'system'
    });
  }
  this.machineId = null;
  this.status = 'unlinked';
  this.linkedAt = null;
  this.linkedBy = null;
  return this.save();
};

module.exports = mongoose.model('Tag', tagSchema);
