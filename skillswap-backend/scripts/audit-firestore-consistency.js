#!/usr/bin/env node

const { getDb, toMillis } = require('./lib/admin');

function isPaidSession(session) {
  return session && session.sessionType !== 'demo' && Number(session.creditsAgreed || 0) > 0;
}

function getTeachSkills(user) {
  return Array.isArray(user?.skills?.toTeach) ? user.skills.toTeach : [];
}

async function main() {
  const db = getDb();
  const [usersSnap, sessionsSnap, transactionsSnap, requestsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('sessions').get(),
    db.collection('transactions').get(),
    db.collection('humanVerificationRequests').get()
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      users: usersSnap.size,
      sessions: sessionsSnap.size,
      transactions: transactionsSnap.size,
      humanVerificationRequests: requestsSnap.size
    },
    issues: {
      usersMissingHeldCreditBalance: [],
      usersMissingHumanVerificationMirror: [],
      teachersMissingTeacherReputation: [],
      paidSessionsMissingEscrowFields: [],
      paidSessionsMissingSettlementStatus: [],
      duplicatePendingHumanVerificationRequests: [],
      transactionsMissingBalances: [],
      sessionsUnderReviewWithoutCase: []
    }
  };

  const pendingRequestsByUid = new Map();

  usersSnap.forEach(docSnap => {
    const user = docSnap.data() || {};
    const uid = docSnap.id;
    if (user.heldCreditBalance == null) report.issues.usersMissingHeldCreditBalance.push(uid);
    if (!user.humanVerification || !user.humanVerification.status) report.issues.usersMissingHumanVerificationMirror.push(uid);
    const shouldHaveTeacherReputation = getTeachSkills(user).length > 0 || !!user.teacherReputation;
    if (shouldHaveTeacherReputation && !user.teacherReputation) report.issues.teachersMissingTeacherReputation.push(uid);
  });

  sessionsSnap.forEach(docSnap => {
    const session = docSnap.data() || {};
    if (isPaidSession(session)) {
      if (session.heldCredits == null || !session.creditStatus) {
        report.issues.paidSessionsMissingEscrowFields.push(docSnap.id);
      }
      if (!session.settlementStatus || !session.teacherAction || !session.studentAction) {
        report.issues.paidSessionsMissingSettlementStatus.push(docSnap.id);
      }
    }
    if (session.settlementStatus === 'review_pending' && !session.creditReviewCaseId) {
      report.issues.sessionsUnderReviewWithoutCase.push(docSnap.id);
    }
  });

  transactionsSnap.forEach(docSnap => {
    const tx = docSnap.data() || {};
    if (tx.balanceAfter == null || tx.heldBalanceAfter == null) {
      report.issues.transactionsMissingBalances.push(docSnap.id);
    }
  });

  requestsSnap.forEach(docSnap => {
    const request = docSnap.data() || {};
    if (request.status !== 'pending' || !request.uid) return;
    if (!pendingRequestsByUid.has(request.uid)) pendingRequestsByUid.set(request.uid, []);
    pendingRequestsByUid.get(request.uid).push({
      id: docSnap.id,
      requestedAt: request.requestedAt,
      updatedAt: request.updatedAt
    });
  });

  pendingRequestsByUid.forEach((items, uid) => {
    if (items.length < 2) return;
    items.sort((a, b) => Math.max(toMillis(b.updatedAt), toMillis(b.requestedAt)) - Math.max(toMillis(a.updatedAt), toMillis(a.requestedAt)));
    report.issues.duplicatePendingHumanVerificationRequests.push({
      uid,
      requestIds: items.map(item => item.id)
    });
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
