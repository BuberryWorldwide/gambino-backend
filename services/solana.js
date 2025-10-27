const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  transfer, getAccount, getMint, burn
} = require('@solana/spl-token');

const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const mint = new PublicKey(process.env.GAMBINO_MINT_ADDRESS);
const loadKP = (json) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));

const treasury = loadKP(process.env.TREASURY_PRIVATE_KEY);

async function getAta(payerKP, owner) {
  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  return getOrCreateAssociatedTokenAccount(connection, payerKP, mint, ownerPk);
}

async function transferFrom(fromKP, toOwner, amount) {
  const src = await getAta(fromKP, fromKP.publicKey);
  const dst = await getAta(fromKP, toOwner);
  return transfer(connection, fromKP, src.address, dst.address, fromKP.publicKey, amount);
}

module.exports = { connection, mint, loadKP, treasury, getAta, transferFrom, burn };
