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
admin.initializeApp({ credential: admin.credential.cert(getFirebaseServiceAccount()) });

async function cleanup() {
    const db = admin.firestore();
    const snap = await db.collection('sessions').get();
    let deleted = 0;

    for (const doc of snap.docs) {
        const d = doc.data();
        const status = d.status || 'upcoming';
        const settlement = d.settlementStatus || '';
        
        // Find sessions still stuck as 'upcoming' or 'awaiting_counterparty' 
        // that also have the old swapped role issue
        const isStuck = (
            (status === 'upcoming' && !settlement) ||
            (status === 'awaiting_counterparty' && settlement === 'awaiting_counterparty')
        );
        
        if (isStuck) {
            const topic = d.topic || 'unknown';
            const teacher = d.teacherName || d.teacherUid || '?';
            const student = d.studentName || d.studentUid || '?';
            console.log(`[DELETE] Session ${doc.id} | status=${status} | topic="${topic}" | teacher=${teacher} | student=${student}`);
            await doc.ref.delete();
            deleted++;
        }
    }

    console.log(`\n✅ Deleted ${deleted} stuck sessions.`);
}

cleanup().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
