const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const REVENUECAT_WEBHOOK_SECRET = defineSecret("REVENUECAT_WEBHOOK_SECRET");

// Firestore trigger: send push notification when pending member created
exports.onPendingMemberCreated = onDocumentCreated(
  {
    document: "groups/{groupId}/pendingMembers/{userId}",
  },
  async (event) => {
    const { groupId, userId } = event.params;
    const pendingData = event.data.data();
    const { displayName } = pendingData;

    const groupDoc = await db.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) {
      console.error("Group not found:", groupId);
      return;
    }
    const groupData = groupDoc.data();
    const managers = groupData.managers || [];
    const groupName = groupData.name || groupId;

    if (managers.length === 0) {
      console.log("No managers to notify for group:", groupId);
      return;
    }

    // Send push notifications to managers
    const fcmTokens = [];
    for (const managerEmail of managers) {
      const userQuery = await db.collection("users").where("email", "==", managerEmail).limit(1).get();
      if (!userQuery.empty) {
        const userData = userQuery.docs[0].data();
        if (userData.fcmToken) {
          fcmTokens.push(userData.fcmToken);
        }
      }
    }

    if (fcmTokens.length > 0) {
      await sendFcmNotifications(
        fcmTokens,
        "New Member Request",
        `${displayName} wants to join ${groupName}`
      );
      console.log(`Sent ${fcmTokens.length} FCM notification(s) to managers for ${displayName} -> ${groupName}`);
    } else {
      console.log("No FCM tokens found for managers");
    }
  }
);

// Firestore trigger: send push notification when member approved (member document created)
exports.onMemberApproved = onDocumentCreated(
  {
    document: "groups/{groupId}/members/{userId}",
  },
  async (event) => {
    const { groupId, userId } = event.params;

    const groupDoc = await db.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) {
      console.error("Group not found:", groupId);
      return;
    }
    const groupName = groupDoc.data().name || groupId;

    // Get the approved user's FCM token
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      console.log("User not found:", userId);
      return;
    }

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      console.log("No FCM token for approved user:", userId);
      return;
    }

    await sendFcmNotifications(
      [fcmToken],
      "Request Approved! ✅",
      `You've been approved to join ${groupName}`
    );
    console.log(`Sent approval notification to ${userId} for ${groupName}`);
  }
);

// ===== PUSH NOTIFICATION HELPERS =====

/**
 * Get the current date string in YYYY-MM-DD for America/Chicago timezone.
 */
function getCSTDateString() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

/**
 * Get the current day of week in America/Chicago timezone (1=Monday, 7=Sunday).
 */
function getCSTDayOfWeek() {
  const cstDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const jsDay = cstDate.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  // Convert to ISO: 1=Monday, 7=Sunday
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Get current time as "HH:MM" in America/Chicago timezone.
 */
function getCSTTimeString() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Subtract N minutes from a "HH:MM" string. Returns "HH:MM".
 */
function subtractMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(":").map(Number);
  const totalMins = h * 60 + m - minutes;
  const newH = Math.floor(((totalMins % 1440) + 1440) % 1440 / 60);
  const newM = ((totalMins % 60) + 60) % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}

/**
 * Get all users in a group that have a given notification preference enabled.
 * Returns array of { uid, fcmToken }.
 * @param {number} currentDay - Current day of week (1=Monday, 7=Sunday). If provided, filters by notifDays.
 */
async function getGroupNotifRecipients(groupId, prefKey, currentDay = null) {
  // Get all member IDs for the group
  const membersSnap = await db
    .collection("groups")
    .doc(groupId)
    .collection("members")
    .get();

  // Also get managers (may not be in members sub-collection)
  const groupDoc = await db.collection("groups").doc(groupId).get();
  const managerEmails = groupDoc.exists ? (groupDoc.data().managers || []) : [];

  const memberIds = new Set();
  membersSnap.forEach((doc) => memberIds.add(doc.id));

  // Fetch user docs for members
  const recipients = [];
  const userPromises = [...memberIds].map(async (uid) => {
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return;
    const data = userDoc.data();
    const prefs = data.notificationPrefs || {};
    const token = data.fcmToken;
    if (!token) return;
    if (!prefs[prefKey]) return;
    
    // Check if today is in user's active notification days
    if (currentDay !== null) {
      const notifDays = data.notifDays || [1, 2, 3, 4, 5]; // Default to Mon-Fri
      if (!notifDays.includes(currentDay)) return;
    }
    
    recipients.push({ uid, fcmToken: token });
  });

  await Promise.all(userPromises);
  return recipients;
}

/**
 * Send FCM multicast to a list of tokens.
 * Automatically skips invalid tokens.
 */
async function sendFcmNotifications(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) {
    console.log("[FCM] No tokens to send to");
    return;
  }

  const messaging = getMessaging();
  const chunkSize = 500; // FCM multicast limit
  const chunks = [];
  for (let i = 0; i < tokens.length; i += chunkSize) {
    chunks.push(tokens.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
        data,
      });
      console.log(
        `[FCM] Sent: ${response.successCount} success, ${response.failureCount} failures`
      );
    } catch (err) {
      console.error("[FCM] sendEachForMulticast error:", err);
    }
  }
}

// ===== SCHEDULED: VOTING REMINDERS =====
// Runs every minute; sends reminder notifications 1 hour before voting closes.
exports.sendVotingReminders = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/Chicago",
  },
  async () => {
    const currentTime = getCSTTimeString(); // e.g. "10:50"
    const today = getCSTDateString();
    const currentDay = getCSTDayOfWeek(); // 1=Monday through 7=Sunday

    console.log(`[Reminders] Checking at ${currentTime} (CST) for date ${today}, day ${currentDay}`);

    // Get all groups
    const groupsSnap = await db.collection("groups").get();
    const groupPromises = groupsSnap.docs.map(async (groupDoc) => {
      const groupId = groupDoc.id;
      const groupData = groupDoc.data();
      const settings = groupData.settings || {};
      const votingCloseTime = settings.votingCloseTime || "11:50";

      // Calculate reminder time (60 minutes before close)
      const reminderTime = subtractMinutes(votingCloseTime, 60);

      if (currentTime !== reminderTime) return;

      // Check idempotency: did we already send a reminder today?
      const logRef = db
        .collection("groups")
        .doc(groupId)
        .collection("notificationLog")
        .doc(today);
      const logDoc = await logRef.get();
      if (logDoc.exists && logDoc.data().reminderSentAt && logDoc.data().reminderCloseTime === votingCloseTime) {
        console.log(`[Reminders] Already sent for group ${groupId} today at ${votingCloseTime}`);
        return;
      }

      // Get recipients who want reminder notifications (filtered by active days)
      const recipients = await getGroupNotifRecipients(groupId, "reminder", currentDay);
      if (recipients.length === 0) {
        console.log(`[Reminders] No opted-in users for group ${groupId} on day ${currentDay}`);
        // Still mark as sent to avoid repeated checks
        await logRef.set({ reminderSentAt: new Date(), reminderCloseTime: votingCloseTime }, { merge: true });
        return;
      }

      const groupName = groupData.name || groupId;
      const tokens = recipients.map((r) => r.fcmToken);

      // Format close time for display (e.g. "11:50" -> "11:50 AM")
      const [closeH, closeM] = votingCloseTime.split(":").map(Number);
      const period = closeH >= 12 ? "PM" : "AM";
      const displayH = closeH > 12 ? closeH - 12 : closeH === 0 ? 12 : closeH;
      const closeDisplay = `${displayH}:${String(closeM).padStart(2, "0")} ${period}`;

      await sendFcmNotifications(
        tokens,
        "🍽️ Vote before it's too late!",
        `Voting closes at ${closeDisplay} — pick your lunch spot for ${groupName}!`,
        { type: "reminder", groupId }
      );

      // Mark as sent (include close time so changing it allows re-send)
      await logRef.set({ reminderSentAt: new Date(), reminderCloseTime: votingCloseTime }, { merge: true });
      console.log(
        `[Reminders] Sent to ${tokens.length} users for group ${groupId} (closes ${closeDisplay})`
      );
    });

    await Promise.all(groupPromises);
  }
);

// ===== SCHEDULED: WINNER ANNOUNCEMENTS =====
// Runs every minute; sends winner notification when voting closes.
exports.sendWinnerAnnouncements = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/Chicago",
  },
  async () => {
    const currentTime = getCSTTimeString();
    const today = getCSTDateString();
    const currentDay = getCSTDayOfWeek(); // 1=Monday through 7=Sunday

    console.log(`[Winners] Checking at ${currentTime} (CST) for date ${today}, day ${currentDay}`);

    const groupsSnap = await db.collection("groups").get();
    const groupPromises = groupsSnap.docs.map(async (groupDoc) => {
      const groupId = groupDoc.id;
      const groupData = groupDoc.data();
      const settings = groupData.settings || {};
      const votingCloseTime = settings.votingCloseTime || "11:50";

      if (currentTime !== votingCloseTime) return;

      // Check idempotency: did we already send for THIS close time today?
      const logRef = db
        .collection("groups")
        .doc(groupId)
        .collection("notificationLog")
        .doc(today);
      const logDoc = await logRef.get();
      if (logDoc.exists && logDoc.data().winnerSentAt && logDoc.data().winnerCloseTime === votingCloseTime) {
        console.log(`[Winners] Already sent for group ${groupId} today at ${votingCloseTime}`);
        return;
      }

      // Mark as sent immediately to prevent duplicate sends (include close time)
      await logRef.set({ winnerSentAt: new Date(), winnerCloseTime: votingCloseTime }, { merge: true });

      // Determine winner from today's votes
      const ballotsSnap = await db
        .collection("groups")
        .doc(groupId)
        .collection("votes")
        .doc(today)
        .collection("ballots")
        .get();

      if (ballotsSnap.empty) {
        console.log(`[Winners] No votes for group ${groupId} today`);
        return;
      }

      // Tally votes
      const tally = {};
      ballotsSnap.forEach((doc) => {
        const { restaurantName } = doc.data();
        if (!restaurantName) return;
        tally[restaurantName] = (tally[restaurantName] || 0) + 1;
      });

      if (Object.keys(tally).length === 0) {
        console.log(`[Winners] Empty tally for group ${groupId}`);
        return;
      }

      // Find winner (most votes; ties broken randomly)
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const maxVotes = sorted[0][1];
      const tied = sorted.filter(([_, v]) => v === maxVotes);
      const winner = tied[Math.floor(Math.random() * tied.length)][0];
      const winnerVotes = tally[winner];
      const totalVotes = Object.values(tally).reduce((s, v) => s + v, 0);

      // Auto-promote daily extra to permanent list if it wins
      const permanentRestaurants = groupData.restaurants || [];
      const winnerId = winner.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const alreadyPermanent = permanentRestaurants.some(
        r => r.id === winnerId || r.name.toLowerCase() === winner.toLowerCase()
      );

      if (!alreadyPermanent) {
        console.log(`[Winners] Auto-promoting "${winner}" to permanent list for group ${groupId}`);
        await db.collection("groups").doc(groupId).update({
          restaurants: FieldValue.arrayUnion({ id: winnerId, name: winner })
        });
      }

      // Get recipients who want winner notifications (filtered by active days)
      const recipients = await getGroupNotifRecipients(groupId, "winner", currentDay);
      if (recipients.length === 0) {
        console.log(`[Winners] No opted-in users for group ${groupId} on day ${currentDay}`);
        return;
      }

      const groupName = groupData.name || groupId;
      const tokens = recipients.map((r) => r.fcmToken);

      await sendFcmNotifications(
        tokens,
        `🏆 Today's winner: ${winner}!`,
        `${winner} won with ${winnerVotes} of ${totalVotes} votes in ${groupName}. Enjoy your lunch!`,
        { type: "winner", groupId, winner }
      );

      console.log(
        `[Winners] Announced "${winner}" to ${tokens.length} users for group ${groupId}`
      );
    });

    await Promise.all(groupPromises);
  }
);

// ===== REVENUECAT WEBHOOK HANDLER =====
// Handles subscription lifecycle events from RevenueCat
exports.onRevenueCatWebhook = onRequest(
  {
    secrets: [REVENUECAT_WEBHOOK_SECRET],
  },
  async (req, res) => {
    // Authenticate webhook request
    const authHeader = req.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${REVENUECAT_WEBHOOK_SECRET.value()}`) {
      console.error("[RevenueCat] Unauthorized webhook request");
      res.status(401).send("Unauthorized");
      return;
    }

    const event = req.body;
    const eventType = event?.event?.type;
    const appUserId = event?.event?.app_user_id;

    if (!eventType || !appUserId) {
      console.error("[RevenueCat] Missing event type or app_user_id");
      res.status(400).send("Bad request");
      return;
    }

    console.log(`[RevenueCat] Received ${eventType} for user ${appUserId}`);

    try {
      const userRef = db.collection("users").doc(appUserId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.warn(`[RevenueCat] User ${appUserId} not found in Firestore`);
        res.status(200).send("OK");
        return;
      }

      const userEmail = userDoc.data().email;

      // Handle activation events
      if (["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION"].includes(eventType)) {
        // Set user subscription to active
        await userRef.update({
          subscriptionStatus: "active",
          groupsFrozenAt: null,
          groupsDeleteAt: null,
        });

        // Find all frozen groups where user is a manager and reactivate them
        const frozenGroupsSnap = await db
          .collection("groups")
          .where("managers", "array-contains", userEmail)
          .where("status", "==", "frozen")
          .get();

        const reactivatePromises = frozenGroupsSnap.docs.map((groupDoc) =>
          db.collection("groups").doc(groupDoc.id).update({
            status: "active",
            frozenAt: null,
            deleteAt: null,
            warningNotificationSent: null,
          })
        );

        await Promise.all(reactivatePromises);

        console.log(
          `[RevenueCat] Activated subscription for ${appUserId}, reactivated ${frozenGroupsSnap.size} groups`
        );
      }
      // Handle expiration/cancellation events
      else if (["EXPIRATION", "CANCELLATION"].includes(eventType)) {
        const now = new Date();
        const fourWeeksLater = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

        // Set user subscription to expired
        await userRef.update({
          subscriptionStatus: "expired",
          groupsFrozenAt: now,
          groupsDeleteAt: fourWeeksLater,
        });

        // Find all active groups where user is a manager and freeze them
        const activeGroupsSnap = await db
          .collection("groups")
          .where("managers", "array-contains", userEmail)
          .where("status", "==", "active")
          .get();

        const freezePromises = activeGroupsSnap.docs.map((groupDoc) =>
          db.collection("groups").doc(groupDoc.id).update({
            status: "frozen",
            frozenAt: now,
            deleteAt: fourWeeksLater,
          })
        );

        await Promise.all(freezePromises);

        console.log(
          `[RevenueCat] Expired subscription for ${appUserId}, froze ${activeGroupsSnap.size} groups`
        );
      }

      res.status(200).send("OK");
    } catch (error) {
      console.error("[RevenueCat] Error processing webhook:", error);
      res.status(500).send("Internal server error");
    }
  }
);

// ===== SCHEDULED: CLEANUP FROZEN GROUPS =====
// Runs daily at midnight CST to delete expired groups and send warnings
exports.cleanupFrozenGroups = onSchedule(
  {
    schedule: "0 0 * * *", // Daily at midnight
    timeZone: "America/Chicago",
  },
  async () => {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    console.log(`[Cleanup] Starting frozen group cleanup at ${now.toISOString()}`);

    // === Delete groups that have reached their deleteAt time ===
    const groupsToDeleteSnap = await db
      .collection("groups")
      .where("status", "==", "frozen")
      .where("deleteAt", "<=", now)
      .get();

    console.log(`[Cleanup] Found ${groupsToDeleteSnap.size} groups to delete`);

    for (const groupDoc of groupsToDeleteSnap.docs) {
      const groupId = groupDoc.id;
      const groupData = groupDoc.data();
      const groupName = groupData.name || groupId;

      try {
        // Get all members to notify them
        const membersSnap = await db
          .collection("groups")
          .doc(groupId)
          .collection("members")
          .get();

        // Collect FCM tokens from members
        const memberTokens = [];
        for (const memberDoc of membersSnap.docs) {
          const memberId = memberDoc.id;
          const userDoc = await db.collection("users").doc(memberId).get();
          if (userDoc.exists) {
            const token = userDoc.data().fcmToken;
            if (token) memberTokens.push(token);
          }
        }

        // Send deletion notification to all members
        if (memberTokens.length > 0) {
          await sendFcmNotifications(
            memberTokens,
            "Group Deleted",
            `${groupName} has been deleted because the manager's subscription expired.`,
            { type: "group_deleted", groupId }
          );
          console.log(`[Cleanup] Notified ${memberTokens.length} members of ${groupName} deletion`);
        }

        // Delete subcollections (delete nested collections first, then parent docs)
        const subcollections = ["votes", "members", "pendingMembers", "notificationLog"];
        for (const subcollection of subcollections) {
          const subcollectionSnap = await db
            .collection("groups")
            .doc(groupId)
            .collection(subcollection)
            .get();

          // For votes, delete nested subcollections first
          if (subcollection === "votes") {
            for (const voteDoc of subcollectionSnap.docs) {
              // 1. Delete ballots subcollection
              const ballotsSnap = await voteDoc.ref.collection("ballots").get();
              await Promise.all(ballotsSnap.docs.map((doc) => doc.ref.delete()));
              
              // 2. Delete extras subcollection
              const extrasSnap = await voteDoc.ref.collection("extras").get();
              await Promise.all(extrasSnap.docs.map((doc) => doc.ref.delete()));
              
              // 3. Delete the vote doc itself
              await voteDoc.ref.delete();
            }
          } else {
            // Delete each document in the subcollection
            const deletePromises = subcollectionSnap.docs.map((doc) => doc.ref.delete());
            await Promise.all(deletePromises);
          }
        }

        // Delete the group document
        await db.collection("groups").doc(groupId).delete();
        console.log(`[Cleanup] Deleted group ${groupId} (${groupName})`);
      } catch (error) {
        console.error(`[Cleanup] Error deleting group ${groupId}:`, error);
      }
    }

    // === Send 7-day warnings to managers ===
    const groupsToWarnSnap = await db
      .collection("groups")
      .where("status", "==", "frozen")
      .where("deleteAt", "<=", sevenDaysFromNow)
      .where("deleteAt", ">", now)
      .get();

    console.log(`[Cleanup] Found ${groupsToWarnSnap.size} groups within 7-day warning window`);

    for (const groupDoc of groupsToWarnSnap.docs) {
      const groupId = groupDoc.id;
      const groupData = groupDoc.data();
      const groupName = groupData.name || groupId;

      // Skip if warning already sent
      if (groupData.warningNotificationSent) {
        continue;
      }

      try {
        const managers = groupData.managers || [];
        const managerTokens = [];

        // Get FCM tokens for managers
        for (const managerEmail of managers) {
          // Find user by email
          const usersSnap = await db
            .collection("users")
            .where("email", "==", managerEmail)
            .limit(1)
            .get();

          if (!usersSnap.empty) {
            const userDoc = usersSnap.docs[0];
            const token = userDoc.data().fcmToken;
            if (token) managerTokens.push(token);
          }
        }

        if (managerTokens.length > 0) {
          await sendFcmNotifications(
            managerTokens,
            "⚠️ Groups Expiring Soon",
            `Your groups will be deleted in 7 days. Resubscribe now to keep ${groupName} and your other groups.`,
            { type: "expiration_warning", groupId }
          );

          // Mark warning as sent
          await db.collection("groups").doc(groupId).update({
            warningNotificationSent: true,
          });

          console.log(`[Cleanup] Sent 7-day warning for group ${groupId} to ${managerTokens.length} managers`);
        }
      } catch (error) {
        console.error(`[Cleanup] Error sending warning for group ${groupId}:`, error);
      }
    }

    console.log("[Cleanup] Frozen group cleanup completed");
  }
);

// Export helper functions for testing
exports.getCSTDateString = getCSTDateString;
exports.getCSTDayOfWeek = getCSTDayOfWeek;
exports.getCSTTimeString = getCSTTimeString;
exports.subtractMinutes = subtractMinutes;
exports.getGroupNotifRecipients = getGroupNotifRecipients;
exports.sendFcmNotifications = sendFcmNotifications;

