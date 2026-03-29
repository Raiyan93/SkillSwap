const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function normalizePrivateKey(value) {
  return value ? value.replace(/\\n/g, '\n') : value;
}

function getFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const parsed = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
    return parsed;
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
    return parsed;
  }
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
    };
  }
  return null;
}

function ensureAdminInitialized() {
  const serviceAccount = getFirebaseServiceAccount();
  if (!serviceAccount) {
    throw new Error('Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON, or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
  }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
}

function getDb() {
  ensureAdminInitialized();
  return admin.firestore();
}

function getAuth() {
  ensureAdminInitialized();
  return admin.auth();
}

async function deleteDocs(querySnap) {
  if (!querySnap || querySnap.empty) return 0;
  const db = getDb();
  let deleted = 0;
  let batch = db.batch();
  let ops = 0;

  for (const docSnap of querySnap.docs) {
    batch.delete(docSnap.ref);
    deleted += 1;
    ops += 1;
    if (ops === 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  return deleted;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

module.exports = {
  admin,
  ensureAdminInitialized,
  getFirebaseServiceAccount,
  getDb,
  getAuth,
  deleteDocs,
  toMillis
};
