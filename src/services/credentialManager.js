require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");

class CredentialManager {
  constructor() {
    this.masterKey = this.getMasterKey();
    this.vaultPath = "/opt/gambino/secure-vault";

    this.credentialLevels = {
      jackpotReserve: "CRITICAL",
      operationsReserve: "HIGH",
      teamReserve: "HIGH",
      communityRewards: "MEDIUM",
      marketing: "LOW",
      testing: "LOW",
    };

    this.initializeVault();
  }

  getMasterKey() {
    const masterKey = process.env.TREASURY_MASTER_KEY;

    if (!masterKey) {
      console.warn("⚠️  No TREASURY_MASTER_KEY found - generating temporary key");
      const tempKey = crypto.randomBytes(32).toString("hex");
      console.log(`🔑 Temporary Master Key: ${tempKey}`);
      console.log("⚠️  Add this to your .env file: TREASURY_MASTER_KEY=" + tempKey);
      return tempKey;
    }

    return masterKey;
  }

  initializeVault() {
    try {
      if (!fs.existsSync(this.vaultPath)) {
        fs.mkdirSync(this.vaultPath, { recursive: true, mode: 0o700 });
        console.log(`🔒 Created secure vault: ${this.vaultPath}`);
      }
    } catch (error) {
      console.error("❌ Failed to create vault directory:", error);
      throw error;
    }
  }

  encryptCredential(data, accountType) {
    try {
      const algorithm = "aes-256-gcm";
      const key = crypto.scryptSync(this.masterKey, `salt_${accountType}`, 32);
      const iv = crypto.randomBytes(16);

      const cipher = crypto.createCipheriv(algorithm, key, iv);
      cipher.setAAD(Buffer.from(accountType));

      let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
      encrypted += cipher.final("hex");

      const authTag = cipher.getAuthTag();

      return {
        encrypted,
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        algorithm,
        accountType,
        encryptedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        `Encryption failed for ${accountType}: ${error.message}`
      );
    }
  }

  decryptCredential(encryptedData, accountType) {
    try {
      const { encrypted, iv, authTag, algorithm } = encryptedData;
      const key = crypto.scryptSync(this.masterKey, `salt_${accountType}`, 32);

      const decipher = crypto.createDecipheriv(
        algorithm,
        key,
        Buffer.from(iv, "hex")
      );
      decipher.setAAD(Buffer.from(accountType));
      decipher.setAuthTag(Buffer.from(authTag, "hex"));

      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted);
    } catch (error) {
      throw new Error(
        `Decryption failed for ${accountType}: ${error.message}`
      );
    }
  }

  async storeCredentials(accountType, credentials) {
    try {
      const securityLevel = this.credentialLevels[accountType] || "MEDIUM";

      const credentialData = {
        ...credentials,
        accountType,
        securityLevel,
        storedAt: new Date().toISOString(),
        lastAccessed: null,
        accessCount: 0,
      };

      const encryptedData = this.encryptCredential(credentialData, accountType);

      const vaultEntry = {
        accountType,
        securityLevel,
        encryptedData,
        metadata: {
          label: credentials.label || `${accountType} Treasury`,
          purpose: credentials.purpose || accountType,
          percentage: credentials.percentage || 0,
          publicKey: credentials.publicKey,
          tokenAccount: credentials.tokenAccount,
        },
        storedAt: new Date().toISOString(),
        version: "1.0",
      };

      const vaultFile = path.join(this.vaultPath, `${accountType}.vault`);
      fs.writeFileSync(vaultFile, JSON.stringify(vaultEntry, null, 2), {
        mode: 0o600,
      });

      console.log(
        `🔒 Stored ${securityLevel} security credentials for ${accountType}`
      );
      this.logCredentialAccess(accountType, "STORE", "SUCCESS");

      return { success: true, securityLevel, vaultFile };
    } catch (error) {
      console.error(`❌ Failed to store credentials for ${accountType}:`, error);
      this.logCredentialAccess(
        accountType,
        "STORE",
        "FAILED",
        "",
        error.message
      );
      return { success: false, error: error.message };
    }
  }

  async retrieveCredentials(accountType, reason = "GENERAL") {
    try {
      const vaultFile = path.join(this.vaultPath, `${accountType}.vault`);

      if (!fs.existsSync(vaultFile)) {
        throw new Error(`Credentials not found for ${accountType}`);
      }

      const vaultEntry = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
      const credentials = this.decryptCredential(
        vaultEntry.encryptedData,
        accountType
      );

      credentials.lastAccessed = new Date().toISOString();
      credentials.accessCount = (credentials.accessCount || 0) + 1;

      vaultEntry.encryptedData = this.encryptCredential(credentials, accountType);
      fs.writeFileSync(vaultFile, JSON.stringify(vaultEntry, null, 2), {
        mode: 0o600,
      });

      this.logCredentialAccess(accountType, "RETRIEVE", "SUCCESS", reason);

      return {
        success: true,
        credentials,
        securityLevel: vaultEntry.securityLevel,
        metadata: vaultEntry.metadata,
      };
    } catch (error) {
      this.logCredentialAccess(
        accountType,
        "RETRIEVE",
        "FAILED",
        reason,
        error.message
      );
      return { success: false, error: error.message };
    }
  }

  async getKeypair(accountType, reason = "TRANSACTION") {
    try {
      const result = await this.retrieveCredentials(accountType, reason);

      if (!result.success) throw new Error(result.error);

      const { secretKey } = result.credentials;
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

      return { success: true, keypair, securityLevel: result.securityLevel };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listCredentials() {
    try {
      if (!fs.existsSync(this.vaultPath)) {
        return { success: true, credentials: [] };
      }

      const vaultFiles = fs
        .readdirSync(this.vaultPath)
        .filter((f) => f.endsWith(".vault"));

      const credentials = vaultFiles.map((file) => {
        try {
          const vaultEntry = JSON.parse(
            fs.readFileSync(path.join(this.vaultPath, file), "utf8")
          );
          return {
            accountType: vaultEntry.accountType,
            securityLevel: vaultEntry.securityLevel,
            metadata: vaultEntry.metadata,
            storedAt: vaultEntry.storedAt,
            file,
          };
        } catch (error) {
          console.warn(`⚠️  Failed to read vault file ${file}:`, error.message);
          return null;
        }
      }).filter(Boolean);

      return { success: true, credentials };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  logCredentialAccess(accountType, action, result, reason = "", error = "") {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        accountType,
        action,
        result,
        reason,
        error,
        pid: process.pid,
        user: process.env.USER || "unknown",
      };

      const logsDir = path.join(this.vaultPath, "logs");
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const logFile = path.join(logsDir, "access.log");
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      console.error("❌ Failed to write access log:", error);
    }
  }

  async verifyVaultIntegrity() {
    try {
      const results = {
        totalCredentials: 0,
        successfulDecryptions: 0,
        failedDecryptions: 0,
        missingCredentials: [],
        securityLevels: {},
      };

      const expectedAccounts = Object.keys(this.credentialLevels);

      for (const accountType of expectedAccounts) {
        results.totalCredentials++;
        const result = await this.retrieveCredentials(
          accountType,
          "INTEGRITY_CHECK"
        );

        if (result.success) {
          results.successfulDecryptions++;
          results.securityLevels[accountType] = result.securityLevel;
        } else {
          results.failedDecryptions++;
          results.missingCredentials.push(accountType);
        }
      }

      const integrityScore =
        results.totalCredentials > 0
          ? (results.successfulDecryptions / results.totalCredentials) * 100
          : 0;

      return { success: true, results, integrityScore };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async emergencyLockdown(reason) {
    try {
      const lockdownFile = path.join(this.vaultPath, "EMERGENCY_LOCKDOWN");
      const lockdownData = {
        locked: true,
        reason,
        timestamp: new Date().toISOString(),
        user: process.env.USER || "system",
      };

      fs.writeFileSync(lockdownFile, JSON.stringify(lockdownData, null, 2));

      console.log(`🚨 EMERGENCY LOCKDOWN ACTIVATED: ${reason}`);
      this.logCredentialAccess("ALL", "EMERGENCY_LOCKDOWN", "SUCCESS", reason);

      return { success: true, reason };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  isLocked() {
    const lockdownFile = path.join(this.vaultPath, "EMERGENCY_LOCKDOWN");
    return fs.existsSync(lockdownFile);
  }
}

module.exports = CredentialManager;
