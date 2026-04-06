const path = require('path');
const { admin, getDb } = require('./lib/admin');
const skillPricing = require(path.join(__dirname, '..', '..', 'MiniPROJECT', 'skill-pricing.js'));

function isSettledCompletedSession(session) {
  return session && session.status === 'completed' && (session.settlementStatus === 'settled' || !session.settlementStatus);
}

function isPaidSession(session) {
  return !!(session && session.sessionType !== 'demo' && Number(session.creditsAgreed || session.heldCredits || 0) > 0);
}

function getRatingEntry(session, raterUid) {
  const ratings = session && session.ratings ? session.ratings : {};
  return ratings && ratings[raterUid] ? ratings[raterUid] : null;
}

function normalizeFeedback(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getCanonicalOrDerivedRatingEntry(session, raterUid) {
  const direct = getRatingEntry(session, raterUid);
  if (direct) {
    const directRating = Number(direct.rating || 0);
    const directFeedback = normalizeFeedback(direct.feedback);
    if (directRating > 0 || directFeedback) {
      return { rating: directRating, feedback: directFeedback };
    }
  }
  if (!isSettledCompletedSession(session)) return null;
  const response = raterUid === session.teacherUid
    ? session.teacherResponse
    : (raterUid === session.studentUid ? session.studentResponse : null);
  if (!response) return null;
  const responseRating = Number(response.rating || 0);
  const responseFeedback = normalizeFeedback(response.feedback || response.note || '');
  if (!(responseRating > 0 || responseFeedback)) return null;
  return { rating: responseRating, feedback: responseFeedback };
}

function getBadgeTier(completedPaidSessions) {
  if (completedPaidSessions >= 20) return 'gold';
  if (completedPaidSessions >= 10) return 'silver';
  if (completedPaidSessions >= 5) return 'bronze';
  return 'none';
}

function recomputeTeachSkills(profile) {
  const teachSkills = Array.isArray(profile?.skills?.toTeach) ? profile.skills.toTeach : [];
  return teachSkills.map((skill) => ({
    ...skill,
    credits: skillPricing.getCredits(skill?.name || '', skill?.level || '')
  }));
}

function buildUserSummary(uid, profile, sessions) {
  let sessionsCompleted = 0;
  let sessionsTaught = 0;
  let paidSessionsTaught = 0;
  let teacherTotalRatings = 0;
  let teacherRatingTotal = 0;
  let learnerTotalRatings = 0;
  let learnerRatingTotal = 0;
  let completedTeachingSessions = 0;
  let completedDemoSessions = 0;
  let completedPaidSessions = 0;
  let writtenLearnerFeedbackCount = 0;
  let disputeCount = 0;
  let noShowCount = 0;

  sessions.forEach((session) => {
    const isTeacher = session.teacherUid === uid;
    const isLearner = session.studentUid === uid;
    if (!isTeacher && !isLearner) return;

    if (session.status === 'disputed' || session.settlementStatus === 'review_pending' || session.creditReviewCaseId) {
      if (isTeacher) disputeCount += 1;
    }
    if (session.status === 'no-show' && session.noShowType === 'teacher' && isTeacher) {
      noShowCount += 1;
    }

    if (!isSettledCompletedSession(session)) return;

    sessionsCompleted += 1;
    if (isTeacher) {
      sessionsTaught += 1;
      completedTeachingSessions += 1;
      if (isPaidSession(session)) {
        paidSessionsTaught += 1;
        completedPaidSessions += 1;
      } else {
        completedDemoSessions += 1;
      }
      const learnerFeedback = getCanonicalOrDerivedRatingEntry(session, session.studentUid);
      const learnerRatingValue = Number(learnerFeedback?.rating || 0);
      if (learnerRatingValue > 0) {
        teacherTotalRatings += 1;
        teacherRatingTotal += learnerRatingValue;
      }
      if (learnerFeedback && String(learnerFeedback.feedback || '').trim()) {
        writtenLearnerFeedbackCount += 1;
      }
    }
    if (isLearner) {
      const teacherFeedback = getCanonicalOrDerivedRatingEntry(session, session.teacherUid);
      const teacherRatingValue = Number(teacherFeedback?.rating || 0);
      if (teacherRatingValue > 0) {
        learnerTotalRatings += 1;
        learnerRatingTotal += teacherRatingValue;
      }
    }
  });

  const teacherAverageRating = teacherTotalRatings ? teacherRatingTotal / teacherTotalRatings : 0;
  const learnerAverageRating = learnerTotalRatings ? learnerRatingTotal / learnerTotalRatings : 0;
  const verificationStatus = String(profile?.verification?.status || '').toLowerCase();
  const teachSkills = Array.isArray(profile?.skills?.toTeach) ? profile.skills.toTeach : [];

  return {
    stats: {
      averageRating: teacherAverageRating || learnerAverageRating || 0,
      totalRatings: teacherTotalRatings,
      teacherAverageRating,
      teacherTotalRatings,
      learnerAverageRating,
      learnerTotalRatings,
      sessionsCompleted,
      sessionsTaught,
      paidSessionsTaught
    },
    teacherReputation: {
      completedTeachingSessions,
      completedDemoSessions,
      completedPaidSessions,
      writtenLearnerFeedbackCount,
      averageRating: teacherAverageRating,
      totalRatings: teacherTotalRatings,
      noShowCount,
      disputeCount,
      badgeTier: getBadgeTier(completedPaidSessions),
      eligibleForHumanReview: verificationStatus === 'verified' && teachSkills.length > 0 && completedTeachingSessions >= 5,
      requirementProgress: {
        aiVerified: verificationStatus === 'verified',
        teachSkillsCount: teachSkills.length,
        sessionsCompleted: completedTeachingSessions,
        sessionsRequired: 5
      }
    }
  };
}

async function main() {
  const db = getDb();
  const [usersSnap, sessionsSnap, lessonRequestsSnap, lessonConnectionsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('sessions').get(),
    db.collection('lessonRequests').get(),
    db.collection('lessonConnections').get()
  ]);

  const allSessions = sessionsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  const userSkillMap = new Map();
  let batch = db.batch();
  let batchOps = 0;
  let updatedUsers = 0;

  for (const userSnap of usersSnap.docs) {
    const uid = userSnap.id;
    const profile = userSnap.data() || {};
    const updatedTeachSkills = recomputeTeachSkills(profile);
    userSkillMap.set(uid, updatedTeachSkills);
    const summary = buildUserSummary(uid, { ...profile, skills: { ...(profile.skills || {}), toTeach: updatedTeachSkills } }, allSessions);

    batch.set(userSnap.ref, {
      skills: {
        ...(profile.skills || {}),
        toTeach: updatedTeachSkills
      },
      stats: summary.stats,
      teacherReputation: summary.teacherReputation,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    batchOps += 1;
    updatedUsers += 1;

    if (batchOps >= 250) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  batch = db.batch();
  batchOps = 0;
  let updatedPricingDocs = 0;
  const pricingDocs = lessonRequestsSnap.docs.concat(lessonConnectionsSnap.docs);
  for (const docSnap of pricingDocs) {
    const data = docSnap.data() || {};
    if (data.sessionType === 'demo') continue;
    const teacherSkills = userSkillMap.get(data.teacherUid) || [];
    const targetKey = skillPricing.resolveSkillKey(data.skillRequested || '');
    const matched = teacherSkills.find((entry) => skillPricing.resolveSkillKey(entry?.name || '') === targetKey)
      || teacherSkills.find((entry) => String(entry?.name || '').trim().toLowerCase() === String(data.skillRequested || '').trim().toLowerCase());
    const correctedCredits = matched
      ? skillPricing.getCredits(matched?.name || data.skillRequested || '', matched?.level || 'intermediate')
      : skillPricing.getCredits(data.skillRequested || '', 'intermediate');
    if (Number(data.creditsOffered || 0) === correctedCredits) continue;
    batch.set(docSnap.ref, {
      creditsOffered: correctedCredits,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    batchOps += 1;
    updatedPricingDocs += 1;
    if (batchOps >= 250) {
      await batch.commit();
      batch = db.batch();
      batchOps = 0;
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  console.log(`[backfill-role-stats-and-skill-credits] Updated ${updatedUsers} users and ${updatedPricingDocs} pricing docs.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-role-stats-and-skill-credits] Failed:', err);
    process.exit(1);
  });
