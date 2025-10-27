const crypto = require('crypto');
const KEY = crypto.createHash('sha256').update(process.env.KMS_SECRET || 'dev-only').digest(); // 32 bytes

exports.encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({ iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') });
};

exports.decrypt = (pack) => {
  const { iv, ct, tag } = JSON.parse(pack);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
  return pt.toString('utf8');
};
