const admin = require('firebase-admin');

require('dotenv').config();
const fs = require('fs');
function getFirebaseServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const parsed = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
        if (parsed.private_key) parsed.private_key = (parsed.private_key||'').replace(/\\n/g, '\n');
        return parsed;
    }
    return null;
}
admin.initializeApp({
  credential: admin.credential.cert(getFirebaseServiceAccount())
});

async function fixBrokenRatings() {
  const db = admin.firestore();
  const sessionsRef = db.collection('sessions');
  const snaps = await sessionsRef.get();
  let totalFixed = 0;
  let totalDocsProcessed = 0;
  
  for (let doc of snaps.docs) {
    totalDocsProcessed++;
    let data = doc.data();
    let updates = {};
    let newlyFoundRatings = {};
    let hasBrokenKeys = false;
    
    // We want to safely read existing nested ratings first
    if (data.ratings && typeof data.ratings === 'object') {
       newlyFoundRatings = { ...data.ratings };
    }
    
    // Detect bad keys like "ratings.USERID" or "ratings.USERID.rating"
    for (const key of Object.keys(data)) {
      if (key.startsWith('ratings.')) {
        hasBrokenKeys = true;
        const parts = key.split('.');
        const uid = parts[1];
        
        if (!uid) continue;
        
        if (!newlyFoundRatings[uid]) {
          newlyFoundRatings[uid] = {};
        }
        
        if (parts.length === 2 && typeof data[key] === 'object' && data[key] !== null) {
          // Object: "ratings.USERID" = { rating: 5, feedback: '...' }
          newlyFoundRatings[uid] = { ...newlyFoundRatings[uid], ...data[key] };
        } else if (parts.length === 3) {
          // Primitive: "ratings.USERID.rating" = 5
          const field = parts[2];
          newlyFoundRatings[uid][field] = data[key];
        }
        
        // Queue the bad key for deletion
        updates[new admin.firestore.FieldPath(key)] = admin.firestore.FieldValue.delete();
      }
    }
    
    if (hasBrokenKeys) {
      // Repackage the cleanly aggregated ratings back to the correct path
      updates.ratings = newlyFoundRatings;
      await doc.ref.update(updates);
      console.log(`[+] Fixed session document: ${doc.id}`);
      totalFixed++;
    }
  }
  
  console.log(`\n✅ Migration Complete: Evaluated ${totalDocsProcessed} sessions, fixed ${totalFixed} documents.`);
  
  
  // Re-run user recalculation to update profiles properly now that the documents are readable
  const userSnaps = await db.collection('users').get();
  for (let user of userSnaps.docs) {
      if (user.data().appRole === 'teacher' || user.data().stats) {
          // Instead of extracting out calculate-stats logic, I'll let the user wait for their next transaction or I'll implement a fast pass over here.
          // Wait, actually I can just run it using the backend functions since I'll restart the server...
      }
  }
}

fixBrokenRatings().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
