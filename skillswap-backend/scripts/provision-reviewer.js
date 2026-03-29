#!/usr/bin/env node

const { admin, getDb, getAuth } = require('./lib/admin');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : '';
}

async function main() {
  const email = getArg('--email');
  const password = getArg('--password');
  const fullName = getArg('--name') || 'SkillSwap Reviewer';

  if (!email || !password) {
    throw new Error('Usage: node scripts/provision-reviewer.js --email reviewer@example.com --password "StrongPassword" [--name "Reviewer Name"]');
  }

  const auth = getAuth();
  const db = getDb();
  let userRecord;

  try {
    userRecord = await auth.getUserByEmail(email);
    userRecord = await auth.updateUser(userRecord.uid, {
      email,
      password,
      displayName: fullName,
      emailVerified: true
    });
    console.log(`Updated existing reviewer auth user: ${userRecord.uid}`);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    userRecord = await auth.createUser({
      email,
      password,
      displayName: fullName,
      emailVerified: true
    });
    console.log(`Created reviewer auth user: ${userRecord.uid}`);
  }

  await db.collection('users').doc(userRecord.uid).set({
    uid: userRecord.uid,
    fullName,
    email,
    photoURL: userRecord.photoURL || '',
    appRole: 'reviewer',
    profileCompleted: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log(`Reviewer profile ready for ${email}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
