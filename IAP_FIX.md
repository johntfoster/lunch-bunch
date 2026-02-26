# Lunch Bunch IAP Fix — "No subscription offerings available"

## Investigation Summary

**Date:** 2026-02-26

The app code is correctly configured:
- **RevenueCat API Key:** `appl_GMyaXtBHNNCJHzVvGcoWOXygFJv` (configured in `src/index.html` line ~1346)
- **RevenueCat SDK:** `@revenuecat/purchases-capacitor` v12.1.2, properly integrated via CapApp-SPM
- **Product IDs used:** `lunch_bunch_manager_1`, `lunch_bunch_manager_2`, `lunch_bunch_manager_pro`
- **Entitlements expected:** `manager_1`, `manager_2`, `manager_pro`
- **No StoreKit configuration file** exists in the project (no `.storekit` files)

The code calls `Purchases.getOfferings()` and checks for `offerings.current` — if either is null/undefined, it shows the error message. The code itself is fine.

## Root Cause (Most Likely)

The issue is **not in the code** — it's in the backend configuration. One or more of these are incomplete:

### 1. App Store Connect — Products Not Fully Configured ⭐ Most Likely
For subscription products to work on TestFlight, they must be:
- [ ] Created as **Auto-Renewable Subscriptions** in App Store Connect
- [ ] Assigned to a **Subscription Group**
- [ ] Have **Reference Name**, **Product ID**, **Price**, and **Duration** all set
- [ ] Have at least one **Localization** (display name + description)
- [ ] Status should be **"Ready to Submit"** or **"Approved"** (not "Missing Metadata")
- [ ] A **Paid Applications Agreement** must be active in App Store Connect

### 2. RevenueCat Dashboard — No "Current" Offering Set ⭐ Very Likely
In the [RevenueCat Dashboard](https://app.revenuecat.com):
- [ ] Products `lunch_bunch_manager_1`, `lunch_bunch_manager_2`, `lunch_bunch_manager_pro` must be created under **Products**
- [ ] An **Offering** must exist (e.g., "default")
- [ ] The offering must be marked as **"Current"** (this is the one returned by `getOfferings().current`)
- [ ] The offering must contain **Packages** that reference the above products
- [ ] Each package needs a proper identifier (e.g., `$rc_monthly`, `$rc_annual`, or custom like `single`, `plus`, `pro`)

### 3. App Store Connect ↔ RevenueCat Link
- [ ] **Shared Secret** from App Store Connect must be entered in RevenueCat dashboard (App Settings → App Store Connect)
- [ ] The **Bundle ID** in RevenueCat must match the app's bundle ID exactly

## Fix Steps (In Order)

### Step 1: App Store Connect
1. Go to [App Store Connect](https://appstoreconnect.apple.com) → Your App → Subscriptions
2. Verify all 3 subscription products exist with status "Ready to Submit"
3. Ensure each has: price, duration, at least one localization
4. Ensure the Paid Applications Agreement is signed (Agreements, Tax, Banking)

### Step 2: RevenueCat Dashboard
1. Go to [RevenueCat Dashboard](https://app.revenuecat.com) → Your Project → Products
2. Add all 3 products if not already there (use exact App Store product IDs)
3. Go to **Offerings** → Create an offering called "default"
4. Add 3 packages to the offering, each linked to one product
5. **Click "Make Current"** on the offering ← this is critical
6. Under App Settings, add the App Store Connect Shared Secret

### Step 3: Verify
1. Install the TestFlight build on a device
2. The paywall should now load offerings and show prices
3. Use a Sandbox Apple ID to test purchasing

## Notes
- TestFlight builds CAN fetch real product info from App Store Connect (no StoreKit config file needed)
- Products do NOT need to be "Approved" — "Ready to Submit" works for TestFlight/Sandbox
- It can take **15-30 minutes** for new products to propagate after creation
- If using sandbox testing, make sure to sign out of your real Apple ID in Settings → App Store first
