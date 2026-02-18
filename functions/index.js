const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");
const sgMail = require("@sendgrid/mail");

initializeApp();
const db = getFirestore();
const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");

// Simple HMAC token for approve/deny links (no login needed)
const APPROVE_SECRET = "lunch-bunch-approve-secret-2026";

function makeToken(action, groupId, userId) {
  return crypto
    .createHmac("sha256", APPROVE_SECRET)
    .update(`${action}:${groupId}:${userId}`)
    .digest("hex")
    .substring(0, 16);
}

// HTTP endpoint: /approve?g=groupId&u=userId&t=token
exports.approveMember = onRequest(async (req, res) => {
  const { g: groupId, u: userId, t: token, action } = req.query;
  const act = action || "approve";

  if (!groupId || !userId || !token) {
    res.status(400).send(errorPage("Missing parameters"));
    return;
  }

  const expected = makeToken(act, groupId, userId);
  if (token !== expected) {
    res.status(403).send(errorPage("Invalid or expired link"));
    return;
  }

  const groupDoc = await db.collection("groups").doc(groupId).get();
  if (!groupDoc.exists) {
    res.status(404).send(errorPage("Group not found"));
    return;
  }
  const groupName = groupDoc.data().name || groupId;

  const pendingRef = db
    .collection("groups")
    .doc(groupId)
    .collection("pendingMembers")
    .doc(userId);
  const pendingDoc = await pendingRef.get();

  if (!pendingDoc.exists) {
    res.send(resultPage("Already Processed", "This request has already been handled.", groupName));
    return;
  }

  const data = pendingDoc.data();
  const name = data.displayName || data.email || "Unknown";

  if (act === "deny") {
    await pendingRef.delete();
    res.send(resultPage("Request Denied", `${name} has been denied access to ${groupName}.`, groupName, "❌"));
    return;
  }

  // Approve: move to members
  await db
    .collection("groups")
    .doc(groupId)
    .collection("members")
    .doc(userId)
    .set({
      email: data.email,
      displayName: data.displayName,
      joinedAt: new Date(),
    });
  await pendingRef.delete();

  // Set user's selectedGroup
  try {
    await db.collection("users").doc(userId).set({ selectedGroup: groupId }, { merge: true });
  } catch (e) {
    console.warn("Could not set selectedGroup:", e.message);
  }

  res.send(
    resultPage(
      "Member Approved!",
      `${name} now has access to ${groupName}.`,
      groupName,
      "✅"
    )
  );
});

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lunch Bunch</title></head>
<body style="margin:0;padding:40px;background:#1a1a1a;color:#f5e6d0;font-family:Arial,sans-serif;text-align:center;">
<h1 style="color:#e74c3c;">Error</h1><p>${msg}</p>
<a href="https://lunch-bunch-jf.web.app" style="color:#bf5700;">Go to Lunch Bunch</a>
</body></html>`;
}

function resultPage(title, message, groupName, emoji = "🍔") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lunch Bunch</title></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:40px 24px;text-align:center;">
  <div style="font-size:64px;margin-bottom:16px;">${emoji}</div>
  <h1 style="color:#bf5700;font-size:24px;">${title}</h1>
  <p style="color:#a0a0a0;font-size:16px;">${message}</p>
  <a href="https://lunch-bunch-jf.web.app" style="display:inline-block;margin-top:24px;padding:12px 32px;background:#bf5700;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Open Lunch Bunch</a>
</div></body></html>`;
}

// Firestore trigger: send email when pending member created
exports.onPendingMemberCreated = onDocumentCreated(
  {
    document: "groups/{groupId}/pendingMembers/{userId}",
    secrets: [SENDGRID_API_KEY],
  },
  async (event) => {
    const { groupId, userId } = event.params;
    const pendingData = event.data.data();
    const { email, displayName } = pendingData;

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

    sgMail.setApiKey(SENDGRID_API_KEY.value());

    const approveToken = makeToken("approve", groupId, userId);
    const denyToken = makeToken("deny", groupId, userId);

    // Use the HTTP function URLs for approve/deny
    const baseUrl = `https://us-central1-lunch-bunch-jf.cloudfunctions.net/approveMember`;
    const approveUrl = `${baseUrl}?g=${encodeURIComponent(groupId)}&u=${encodeURIComponent(userId)}&t=${approveToken}&action=approve`;
    const denyUrl = `${baseUrl}?g=${encodeURIComponent(groupId)}&u=${encodeURIComponent(userId)}&t=${denyToken}&action=deny`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:48px;">🍔</span>
      <h1 style="color:#bf5700;font-size:24px;margin:8px 0 0;">Lunch Bunch</h1>
    </div>
    <div style="background:#2c2c2c;border-radius:12px;padding:24px;border:1px solid #4a4a4a;">
      <h2 style="color:#f5e6d0;font-size:18px;margin:0 0 16px;">New Member Request</h2>
      <p style="color:#a0a0a0;font-size:15px;margin:0 0 8px;">
        Someone wants to join <strong style="color:#c4841d;">${groupName}</strong>:
      </p>
      <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin:16px 0;">
        <p style="color:#f5e6d0;font-size:16px;margin:0 0 4px;font-weight:bold;">${displayName || "Unknown"}</p>
        <p style="color:#a0a0a0;font-size:14px;margin:0;">${email}</p>
      </div>
      <div style="text-align:center;margin-top:24px;">
        <a href="${approveUrl}" style="display:inline-block;padding:12px 32px;background:#bf5700;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;margin-right:12px;">✅ Approve</a>
        <a href="${denyUrl}" style="display:inline-block;padding:12px 32px;background:#e74c3c;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">❌ Deny</a>
      </div>
    </div>
    <p style="color:#666;font-size:12px;text-align:center;margin-top:16px;">
      You're receiving this because you manage ${groupName} on Lunch Bunch.
    </p>
  </div>
</body>
</html>`;

    const messages = managers.map((managerEmail) => ({
      to: managerEmail,
      from: "johntfosterjr@gmail.com",
      subject: `Lunch Bunch: New member request for ${groupName}`,
      html: htmlBody,
    }));

    try {
      await Promise.all(messages.map((msg) => sgMail.send(msg)));
      console.log(
        `Sent ${messages.length} notification(s) for ${displayName} -> ${groupName}`
      );
    } catch (error) {
      console.error("SendGrid error:", error?.response?.body || error);
    }
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
 */
async function getGroupNotifRecipients(groupId, prefKey) {
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
    // Confirm this user's selectedGroup is actually this group
    if (data.selectedGroup !== groupId) return;
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

    console.log(`[Reminders] Checking at ${currentTime} (CST) for date ${today}`);

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
      if (logDoc.exists && logDoc.data().reminderSentAt) {
        console.log(`[Reminders] Already sent for group ${groupId} today`);
        return;
      }

      // Get recipients who want reminder notifications
      const recipients = await getGroupNotifRecipients(groupId, "reminder");
      if (recipients.length === 0) {
        console.log(`[Reminders] No opted-in users for group ${groupId}`);
        // Still mark as sent to avoid repeated checks
        await logRef.set({ reminderSentAt: new Date() }, { merge: true });
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

      // Mark as sent
      await logRef.set({ reminderSentAt: new Date() }, { merge: true });
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

    console.log(`[Winners] Checking at ${currentTime} (CST) for date ${today}`);

    const groupsSnap = await db.collection("groups").get();
    const groupPromises = groupsSnap.docs.map(async (groupDoc) => {
      const groupId = groupDoc.id;
      const groupData = groupDoc.data();
      const settings = groupData.settings || {};
      const votingCloseTime = settings.votingCloseTime || "11:50";

      if (currentTime !== votingCloseTime) return;

      // Check idempotency: did we already send a winner announcement today?
      const logRef = db
        .collection("groups")
        .doc(groupId)
        .collection("notificationLog")
        .doc(today);
      const logDoc = await logRef.get();
      if (logDoc.exists && logDoc.data().winnerSentAt) {
        console.log(`[Winners] Already sent for group ${groupId} today`);
        return;
      }

      // Mark as sent immediately to prevent duplicate sends
      await logRef.set({ winnerSentAt: new Date() }, { merge: true });

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

      // Find winner (most votes; ties go to whichever was sorted first alphabetically)
      const winner = Object.entries(tally)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      const winnerVotes = tally[winner];
      const totalVotes = Object.values(tally).reduce((s, v) => s + v, 0);

      // Get recipients who want winner notifications
      const recipients = await getGroupNotifRecipients(groupId, "winner");
      if (recipients.length === 0) {
        console.log(`[Winners] No opted-in users for group ${groupId}`);
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
