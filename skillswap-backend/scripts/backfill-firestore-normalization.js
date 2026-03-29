#!/usr/bin/env node

const { admin, getDb, toMillis } = require('./lib/admin');

function getTeachSkills(user) {
  return Array.isArray(user?.skills?.toTeach) ? user.skills.toTeach : [];
}

function isPaidSession(session) {
  return session && session.sessionType !== 'demo' && Number(session.creditsAgreed || 0) > 0;
}

function getBadgeTier(completedPaidSessions) {
  if (completedPaidSessions >= 20) return 'gold';
  if (completedPaidSessions >= 10) return 'silver';
  if (completedPaidSessions >= 5) return 'bronze';
  return 'none';
}

function getLatestRequest(requests) {
  if (!requests.length) return null;
  return requests.slice().sort((a, b) => Math.max(toMillis(b.updatedAt), toMillis(b.reviewedAt), toMillis(b.requestedAt)) - Math.max(toMillis(a.updatedAt), toMillis(a.reviewedAt), toMillis(a.requestedAt)))[0];
}

function buildHumanVerificationMirror(user, requests) {
  const existing = user?.humanVerification || {};
  const latest = getLatestRequest(requests);
  if (latest) {
    return {
      status: latest.status || 'pending',
      requestId: latest.id,
      requestedAt: latest.requestedAt || null,
      reviewedAt: latest.reviewedAt || null,
      reviewedBy: latest.reviewedBy || '',
      reviewedByName: latest.reviewedByName || '',
      reviewNotes: latest.reviewNotes || ''
    };
  }
  if (existing.status && existing.status !== 'not-requested') {
    return {
      status: existing.status,
      requestId: existing.requestId || null,
      requestedAt: existing.requestedAt || null,
      reviewedAt: existing.reviewedAt || null,
      reviewedBy: existing.reviewedBy || '',
      reviewedByName: existing.reviewedByName || '',
      reviewNotes: existing.reviewNotes || ''
    };
  }
  return { status: 'not-requested' };
}

function buildTeacherReputation(user, sessions) {
  const completedSessions = sessions.filter(session => session.status === 'completed');
  const teachSkills = getTeachSkills(user);
  let completedDemoSessions = 0;
  let completedPaidSessions = 0;
  let writtenLearnerFeedbackCount = 0;
  let totalRatings = 0;
  let ratingTotal = 0;
  let noShowCount = 0;
  let disputeCount = 0;

  completedSessions.forEach(session => {
    if (isPaidSession(session)) completedPaidSessions += 1;
    else completedDemoSessions += 1;

    const learnerRating = session?.ratings?.[session.studentUid];
    const ratingValue = Number(learnerRating?.rating || 0);
    if (ratingValue > 0) {
      totalRatings += 1;
      ratingTotal += ratingValue;
    }
    if (learnerRating && typeof learnerRating.feedback === 'string' && learnerRating.feedback.trim()) {
      writtenLearnerFeedbackCount += 1;
    }
  });

  sessions.forEach(session => {
    if (session.status === 'disputed' || session.settlementStatus === 'review_pending' || session.creditReviewCaseId) {
      disputeCount += 1;
    }
    if (session.status === 'no-show' && session.noShowType === 'teacher') {
      noShowCount += 1;
    }
  });

  const completedTeachingSessions = completedSessions.length;
  const averageRating = totalRatings ? ratingTotal / totalRatings : Number(user?.stats?.averageRating || 0);
  const eligibleForHumanReview = (
    user?.verification?.status === 'verified'
    && teachSkills.length > 0
    && completedTeachingSessions >= 5
    && averageRating >= 4
    && writtenLearnerFeedbackCount >= 2
  );

  return {
    completedTeachingSessions,
    completedDemoSessions,
    completedPaidSessions,
    writtenLearnerFeedbackCount,
    averageRating,
    totalRatings,
    noShowCount,
    disputeCount,
    badgeTier: getBadgeTier(completedPaidSessions),
    eligibleForHumanReview,
    requirementProgress: {
      aiVerified: user?.verification?.status === 'verified',
      teachSkillsCount: teachSkills.length,
      sessionsCompleted: completedTeachingSessions,
      sessionsRequired: 5,
      averageRating,
      ratingRequired: 4,
      writtenFeedbackCount: writtenLearnerFeedbackCount,
      feedbackRequired: 2
    }
  };
}

async function main() {
  const db = getDb();
  const [usersSnap, sessionsSnap, requestsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('sessions').get(),
    db.collection('humanVerificationRequests').get()
  ]);

  const sessionsByTeacher = new Map();
  sessionsSnap.forEach(docSnap => {
    const session = { id: docSnap.id, ...docSnap.data() };
    if (!session.teacherUid) return;
    if (!sessionsByTeacher.has(session.teacherUid)) sessionsByTeacher.set(session.teacherUid, []);
    sessionsByTeacher.get(session.teacherUid).push(session);
  });

  const requestsByUid = new Map();
  requestsSnap.forEach(docSnap => {
    const request = { id: docSnap.id, ...docSnap.data() };
    if (!request.uid) return;
    if (!requestsByUid.has(request.uid)) requestsByUid.set(request.uid, []);
    requestsByUid.get(request.uid).push(request);
  });

  let updatedUsers = 0;
  let addedTeacherReputation = 0;
  let normalizedHeldBalance = 0;
  let batch = db.batch();
  let ops = 0;

  for (const docSnap of usersSnap.docs) {
    const user = docSnap.data() || {};
    const uid = docSnap.id;
    const sessions = sessionsByTeacher.get(uid) || [];
    const hasTeacherData = getTeachSkills(user).length > 0 || sessions.length > 0 || !!user.teacherReputation;
    const patch = {
      creditBalance: Math.max(0, Number(user.creditBalance || 0)),
      heldCreditBalance: Math.max(0, Number(user.heldCreditBalance || 0)),
      humanVerification: buildHumanVerificationMirror(user, requestsByUid.get(uid) || []),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (user.heldCreditBalance == null) {
      normalizedHeldBalance += 1;
    }

    if (hasTeacherData) {
      patch.teacherReputation = buildTeacherReputation(user, sessions);
      addedTeacherReputation += 1;
    }

    batch.set(docSnap.ref, patch, { merge: true });
    updatedUsers += 1;
    ops += 1;

    if (ops === 350) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }

  console.log('Firestore normalization complete.');
  console.log(`Users updated: ${updatedUsers}`);
  console.log(`Users normalized with heldCreditBalance: ${normalizedHeldBalance}`);
  console.log(`Users synced with teacherReputation: ${addedTeacherReputation}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
