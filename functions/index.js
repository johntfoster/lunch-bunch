const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
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
