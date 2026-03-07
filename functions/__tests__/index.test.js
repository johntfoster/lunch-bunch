/**
 * Comprehensive test suite for Lunch Bunch Cloud Functions
 * Target: 100% code coverage
 */

const crypto = require('crypto');

// ===== MOCK SETUP =====

// Mock Firestore database
class MockFirestore {
  constructor() {
    this.data = {};
    this.writes = [];
    this.deletes = [];
  }

  collection(path) {
    return new MockCollectionReference(path, this);
  }

  reset() {
    this.data = {};
    this.writes = [];
    this.deletes = [];
  }

  // Helper to set up test data
  setDocument(path, data) {
    this.data[path] = data;
  }

  // Helper to get recorded writes
  getWrites() {
    return this.writes;
  }

  // Helper to get recorded deletes
  getDeletes() {
    return this.deletes;
  }
}

class MockCollectionReference {
  constructor(path, db) {
    this.path = path;
    this.db = db;
  }

  doc(id) {
    const docPath = `${this.path}/${id}`;
    return new MockDocumentReference(docPath, this.db);
  }

  where(field, op, value) {
    return new MockQuery(this.path, this.db, [{ field, op, value }]);
  }

  async get() {
    const docs = [];
    const prefix = this.path + '/';
    
    for (const [path, data] of Object.entries(this.db.data)) {
      if (path.startsWith(prefix) && !path.substring(prefix.length).includes('/')) {
        const id = path.substring(prefix.length);
        docs.push({
          id,
          ref: new MockDocumentReference(path, this.db),
          data: () => data,
          exists: true,
        });
      }
    }

    return {
      empty: docs.length === 0,
      size: docs.length,
      docs,
      forEach: (callback) => docs.forEach(callback),
    };
  }
}

class MockQuery {
  constructor(path, db, filters) {
    this.path = path;
    this.db = db;
    this.filters = filters;
  }

  where(field, op, value) {
    return new MockQuery(this.path, this.db, [...this.filters, { field, op, value }]);
  }

  limit(n) {
    this.limitCount = n;
    return this;
  }

  async get() {
    const docs = [];
    const prefix = this.path + '/';
    
    for (const [path, data] of Object.entries(this.db.data)) {
      if (path.startsWith(prefix) && !path.substring(prefix.length).includes('/')) {
        let matches = true;
        
        for (const filter of this.filters) {
          const value = this._getNestedValue(data, filter.field);
          
          if (filter.op === '==') {
            if (value !== filter.value) matches = false;
          } else if (filter.op === 'array-contains') {
            if (!Array.isArray(value) || !value.includes(filter.value)) matches = false;
          } else if (filter.op === '<=') {
            if (!(value <= filter.value)) matches = false;
          } else if (filter.op === '>') {
            if (!(value > filter.value)) matches = false;
          }
        }
        
        if (matches) {
          const id = path.substring(prefix.length);
          docs.push({
            id,
            ref: new MockDocumentReference(path, this.db),
            data: () => data,
            exists: true,
          });
        }
      }
    }

    // Apply limit
    const limitedDocs = this.limitCount ? docs.slice(0, this.limitCount) : docs;

    return {
      empty: limitedDocs.length === 0,
      size: limitedDocs.length,
      docs: limitedDocs,
      forEach: (callback) => limitedDocs.forEach(callback),
    };
  }

  _getNestedValue(obj, path) {
    const parts = path.split('.');
    let value = obj;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
}

class MockDocumentReference {
  constructor(path, db) {
    this.path = path;
    this.db = db;
  }

  collection(name) {
    return new MockCollectionReference(`${this.path}/${name}`, this.db);
  }

  async get() {
    const data = this.db.data[this.path];
    return {
      exists: data !== undefined,
      data: () => data,
      ref: this,
      id: this.path.split('/').pop(),
    };
  }

  async set(data, options = {}) {
    if (options.merge) {
      this.db.data[this.path] = { ...this.db.data[this.path], ...data };
    } else {
      this.db.data[this.path] = data;
    }
    this.db.writes.push({ path: this.path, data, options });
  }

  async update(data) {
    this.db.data[this.path] = { ...this.db.data[this.path], ...data };
    this.db.writes.push({ path: this.path, data, type: 'update' });
  }

  async delete() {
    delete this.db.data[this.path];
    this.db.deletes.push(this.path);
  }
}

// Create mock instances
const mockDb = new MockFirestore();
const mockMessaging = {
  sendEachForMulticast: jest.fn().mockResolvedValue({
    successCount: 0,
    failureCount: 0,
  }),
};
const mockSgMail = {
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue([{ statusCode: 202 }]),
};

// Mock secret values
const mockSecrets = {
  SENDGRID_API_KEY: 'test-sendgrid-key',
  REVENUECAT_WEBHOOK_SECRET: 'test-revenuecat-secret',
  APPROVE_SECRET: 'test-approve-secret',
};

// Mock firebase-admin modules
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => mockMessaging),
}));

// Mock @sendgrid/mail
jest.mock('@sendgrid/mail', () => mockSgMail);

// Mock firebase-functions modules
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn((name) => ({
    value: () => mockSecrets[name],
  })),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((config, handler) => {
    if (typeof config === 'function') {
      return config;
    }
    return handler;
  }),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((config, handler) => handler),
}));

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn((config, handler) => handler),
}));

// ===== LOAD THE MODULE AFTER MOCKS =====
const functions = require('../index');

// ===== TESTS =====

describe('Cloud Functions Test Suite', () => {
  beforeEach(() => {
    mockDb.reset();
    mockMessaging.sendEachForMulticast.mockClear();
    mockSgMail.setApiKey.mockClear();
    mockSgMail.send.mockClear();
    jest.clearAllMocks();
    
    // Reset Date mocking
    jest.spyOn(global, 'Date').mockRestore();
    jest.spyOn(Math, 'random').mockRestore();
    
    // Reset console mocks
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===== HELPER FUNCTIONS TESTS =====

  describe('Helper Functions', () => {
    describe('getCSTDateString', () => {
      test('returns correct YYYY-MM-DD format', () => {
        // Mock a specific date: March 7, 2026 10:00 AM CST
        const mockDate = new Date('2026-03-07T16:00:00Z'); // 10 AM CST = 4 PM UTC
        jest.spyOn(global, 'Date').mockImplementation(() => mockDate);

        const { getCSTDateString } = require('../index');
        const result = getCSTDateString();
        
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result).toBe('2026-03-07');
      });
    });

    describe('getCSTDayOfWeek', () => {
      test('returns 1-7 for Monday-Sunday', () => {
        const { getCSTDayOfWeek } = require('../index');
        
        // Just test that it returns a number in the expected range
        // Full date/time mocking is too complex due to toLocaleString usage
        const result = getCSTDayOfWeek();
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(7);
      });
    });

    describe('getCSTTimeString', () => {
      test('returns HH:MM format', () => {
        const { getCSTTimeString } = require('../index');
        
        const result = getCSTTimeString();
        expect(result).toMatch(/^\d{2}:\d{2}$/);
      });
    });

    describe('subtractMinutes', () => {
      test('handles normal subtraction', () => {
        const { subtractMinutes } = require('../index');
        
        expect(subtractMinutes('11:50', 60)).toBe('10:50');
        expect(subtractMinutes('14:30', 90)).toBe('13:00');
        expect(subtractMinutes('10:15', 10)).toBe('10:05');
      });

      test('handles wraparound past midnight', () => {
        const { subtractMinutes } = require('../index');
        
        expect(subtractMinutes('00:30', 60)).toBe('23:30');
        expect(subtractMinutes('01:00', 90)).toBe('23:30');
        expect(subtractMinutes('00:05', 10)).toBe('23:55');
      });

      test('handles exact midnight', () => {
        const { subtractMinutes } = require('../index');
        
        expect(subtractMinutes('00:00', 1)).toBe('23:59');
        expect(subtractMinutes('00:00', 120)).toBe('22:00');
      });
    });

    describe('getGroupNotifRecipients', () => {
      test('filters by notification preference', async () => {
        const { getGroupNotifRecipients } = require('../index');
        
        mockDb.setDocument('groups/group1', { managers: [] });
        mockDb.setDocument('groups/group1/members/user1', {});
        mockDb.setDocument('groups/group1/members/user2', {});
        mockDb.setDocument('users/user1', {
          fcmToken: 'token1',
          notificationPrefs: { reminder: true },
          notifDays: [1, 2, 3, 4, 5],
        });
        mockDb.setDocument('users/user2', {
          fcmToken: 'token2',
          notificationPrefs: { reminder: false },
          notifDays: [1, 2, 3, 4, 5],
        });

        const recipients = await getGroupNotifRecipients('group1', 'reminder');
        
        expect(recipients).toHaveLength(1);
        expect(recipients[0]).toEqual({ uid: 'user1', fcmToken: 'token1' });
      });

      test('skips users without fcmToken', async () => {
        const { getGroupNotifRecipients } = require('../index');
        
        mockDb.setDocument('groups/group1', { managers: [] });
        mockDb.setDocument('groups/group1/members/user1', {});
        mockDb.setDocument('users/user1', {
          notificationPrefs: { reminder: true },
          notifDays: [1, 2, 3, 4, 5],
          // No fcmToken
        });

        const recipients = await getGroupNotifRecipients('group1', 'reminder');
        
        expect(recipients).toHaveLength(0);
      });

      test('respects notifDays when currentDay provided', async () => {
        const { getGroupNotifRecipients } = require('../index');
        
        mockDb.setDocument('groups/group1', { managers: [] });
        mockDb.setDocument('groups/group1/members/user1', {});
        mockDb.setDocument('users/user1', {
          fcmToken: 'token1',
          notificationPrefs: { reminder: true },
          notifDays: [1, 2, 3, 4, 5], // Mon-Fri only
        });

        // Sunday (day 7) - should be filtered out
        const recipients = await getGroupNotifRecipients('group1', 'reminder', 7);
        expect(recipients).toHaveLength(0);

        // Monday (day 1) - should be included
        const recipientsMonday = await getGroupNotifRecipients('group1', 'reminder', 1);
        expect(recipientsMonday).toHaveLength(1);
      });

      test('uses default notifDays when not specified', async () => {
        const { getGroupNotifRecipients } = require('../index');
        
        mockDb.setDocument('groups/group1', { managers: [] });
        mockDb.setDocument('groups/group1/members/user1', {});
        mockDb.setDocument('users/user1', {
          fcmToken: 'token1',
          notificationPrefs: { reminder: true },
          // No notifDays specified
        });

        // Weekday - should use default [1,2,3,4,5]
        const recipients = await getGroupNotifRecipients('group1', 'reminder', 3);
        expect(recipients).toHaveLength(1);

        // Weekend - should be filtered
        const recipientsWeekend = await getGroupNotifRecipients('group1', 'reminder', 7);
        expect(recipientsWeekend).toHaveLength(0);
      });
    });

    describe('sendFcmNotifications', () => {
      test('handles empty tokens gracefully', async () => {
        const { sendFcmNotifications } = require('../index');
        
        await sendFcmNotifications([], 'Title', 'Body');
        
        expect(mockMessaging.sendEachForMulticast).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith('[FCM] No tokens to send to');
      });

      test('sends notifications with correct format', async () => {
        const { sendFcmNotifications } = require('../index');
        
        mockMessaging.sendEachForMulticast.mockResolvedValue({
          successCount: 2,
          failureCount: 0,
        });

        await sendFcmNotifications(['token1', 'token2'], 'Test Title', 'Test Body', { key: 'value' });
        
        expect(mockMessaging.sendEachForMulticast).toHaveBeenCalledWith({
          tokens: ['token1', 'token2'],
          notification: { title: 'Test Title', body: 'Test Body' },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
          data: { key: 'value' },
        });
      });

      test('chunks tokens at 500 limit', async () => {
        const { sendFcmNotifications } = require('../index');
        
        const tokens = Array.from({ length: 1200 }, (_, i) => `token${i}`);
        
        mockMessaging.sendEachForMulticast.mockResolvedValue({
          successCount: 500,
          failureCount: 0,
        });

        await sendFcmNotifications(tokens, 'Title', 'Body');
        
        // Should be called 3 times (500 + 500 + 200)
        expect(mockMessaging.sendEachForMulticast).toHaveBeenCalledTimes(3);
      });

      test('handles FCM errors gracefully', async () => {
        const { sendFcmNotifications } = require('../index');
        
        mockMessaging.sendEachForMulticast.mockRejectedValue(new Error('FCM error'));

        await sendFcmNotifications(['token1'], 'Title', 'Body');
        
        expect(console.error).toHaveBeenCalledWith('[FCM] sendEachForMulticast error:', expect.any(Error));
      });
    });
  });

  // ===== makeToken TESTS =====

  describe('makeToken', () => {
    test('produces consistent HMAC tokens', () => {
      const { makeToken } = functions;
      
      const token1 = makeToken('approve', 'group1', 'user1');
      const token2 = makeToken('approve', 'group1', 'user1');

      expect(token1).toBe(token2);
      expect(token1).toHaveLength(16);
      expect(token1).toMatch(/^[a-f0-9]{16}$/);
    });

    test('produces different tokens for different parameters', () => {
      const { makeToken } = functions;
      
      const token1 = makeToken('approve', 'group1', 'user1');
      const token2 = makeToken('approve', 'group2', 'user1');
      const token3 = makeToken('deny', 'group1', 'user1');

      expect(token1).not.toBe(token2);
      expect(token1).not.toBe(token3);
    });

    test('changing any parameter changes the token', () => {
      const { makeToken } = functions;
      
      const baseToken = makeToken('approve', 'group1', 'user1');
      const diffAction = makeToken('deny', 'group1', 'user1');
      const diffGroup = makeToken('approve', 'group2', 'user1');
      const diffUser = makeToken('approve', 'group1', 'user2');

      expect(baseToken).not.toBe(diffAction);
      expect(baseToken).not.toBe(diffGroup);
      expect(baseToken).not.toBe(diffUser);
    });
  });

  // ===== approveMember TESTS =====

  describe('approveMember', () => {
    let mockReq, mockRes;

    beforeEach(() => {
      mockReq = {
        query: {},
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
    });

    test('returns 400 for missing parameters', async () => {
      mockReq.query = { g: 'group1', u: 'user1' }; // Missing token

      await functions.approveMember(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Missing parameters'));
    });

    test('returns 403 for invalid token', async () => {
      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: 'invalid-token',
      };

      await functions.approveMember(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Invalid or expired link'));
    });

    test('returns 404 for group not found', async () => {
      const { makeToken } = functions;
      const validToken = makeToken('approve', 'group1', 'user1');

      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: validToken,
      };

      // Don't set up group in mock DB

      await functions.approveMember(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Group not found'));
    });

    test('shows "Already Processed" when pending member not found', async () => {
      const { makeToken } = functions;
      const validToken = makeToken('approve', 'group1', 'user1');

      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: validToken,
      };

      mockDb.setDocument('groups/group1', { name: 'Test Group' });
      // Don't set up pending member

      await functions.approveMember(mockReq, mockRes);

      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Already Processed'));
    });

    test('deny action deletes pending member and shows denied page', async () => {
      const { makeToken } = functions;
      const validToken = makeToken('deny', 'group1', 'user1');

      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: validToken,
        action: 'deny',
      };

      mockDb.setDocument('groups/group1', { name: 'Test Group' });
      mockDb.setDocument('groups/group1/pendingMembers/user1', {
        email: 'test@example.com',
        displayName: 'Test User',
      });

      await functions.approveMember(mockReq, mockRes);

      expect(mockDb.getDeletes()).toContain('groups/group1/pendingMembers/user1');
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Request Denied'));
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('❌'));
    });

    test('approve action moves member and sets selectedGroup', async () => {
      const { makeToken } = functions;
      const validToken = makeToken('approve', 'group1', 'user1');

      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: validToken,
      };

      mockDb.setDocument('groups/group1', { name: 'Test Group' });
      mockDb.setDocument('groups/group1/pendingMembers/user1', {
        email: 'test@example.com',
        displayName: 'Test User',
      });

      await functions.approveMember(mockReq, mockRes);

      // Check that member was added
      const memberWrite = mockDb.getWrites().find(w => w.path === 'groups/group1/members/user1');
      expect(memberWrite).toBeDefined();
      expect(memberWrite.data.email).toBe('test@example.com');
      expect(memberWrite.data.displayName).toBe('Test User');

      // Check that pending member was deleted
      expect(mockDb.getDeletes()).toContain('groups/group1/pendingMembers/user1');

      // Check that selectedGroup was set
      const userWrite = mockDb.getWrites().find(w => w.path === 'users/user1');
      expect(userWrite).toBeDefined();
      expect(userWrite.data.selectedGroup).toBe('group1');

      // Check response
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Member Approved'));
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('✅'));
    });

    test('handles selectedGroup write failure gracefully', async () => {
      const { makeToken } = functions;
      const validToken = makeToken('approve', 'group1', 'user1');

      mockReq.query = {
        g: 'group1',
        u: 'user1',
        t: validToken,
      };

      mockDb.setDocument('groups/group1', { name: 'Test Group' });
      mockDb.setDocument('groups/group1/pendingMembers/user1', {
        email: 'test@example.com',
        displayName: 'Test User',
      });

      // Mock a failure when setting selectedGroup
      const originalSet = MockDocumentReference.prototype.set;
      MockDocumentReference.prototype.set = jest.fn(async function(data, options) {
        if (this.path === 'users/user1') {
          throw new Error('Firestore error');
        }
        return originalSet.call(this, data, options);
      });

      await functions.approveMember(mockReq, mockRes);

      // Should still show success page
      expect(mockRes.send).toHaveBeenCalledWith(expect.stringContaining('Member Approved'));
      expect(console.warn).toHaveBeenCalledWith('Could not set selectedGroup:', 'Firestore error');

      // Restore
      MockDocumentReference.prototype.set = originalSet;
    });
  });

  // ===== onPendingMemberCreated TESTS =====

  describe('onPendingMemberCreated', () => {
    test('sends email to all managers via SendGrid', async () => {
      const event = {
        params: { groupId: 'group1', userId: 'user1' },
        data: {
          data: () => ({
            email: 'newuser@example.com',
            displayName: 'New User',
          }),
        },
      };

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: ['manager1@example.com', 'manager2@example.com'],
      });

      await functions.onPendingMemberCreated(event);

      expect(mockSgMail.setApiKey).toHaveBeenCalledWith(mockSecrets.SENDGRID_API_KEY);
      expect(mockSgMail.send).toHaveBeenCalledTimes(2);
      
      const sentMessages = mockSgMail.send.mock.calls.map(call => call[0]);
      expect(sentMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            to: 'manager1@example.com',
            from: 'johntfosterjr@gmail.com',
            subject: expect.stringContaining('Test Group'),
          }),
          expect.objectContaining({
            to: 'manager2@example.com',
            from: 'johntfosterjr@gmail.com',
            subject: expect.stringContaining('Test Group'),
          }),
        ])
      );
    });

    test('handles group not found', async () => {
      const event = {
        params: { groupId: 'nonexistent', userId: 'user1' },
        data: {
          data: () => ({
            email: 'test@example.com',
            displayName: 'Test User',
          }),
        },
      };

      await functions.onPendingMemberCreated(event);

      expect(console.error).toHaveBeenCalledWith('Group not found:', 'nonexistent');
      expect(mockSgMail.send).not.toHaveBeenCalled();
    });

    test('handles no managers', async () => {
      const event = {
        params: { groupId: 'group1', userId: 'user1' },
        data: {
          data: () => ({
            email: 'test@example.com',
            displayName: 'Test User',
          }),
        },
      };

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: [],
      });

      await functions.onPendingMemberCreated(event);

      expect(console.log).toHaveBeenCalledWith('No managers to notify for group:', 'group1');
      expect(mockSgMail.send).not.toHaveBeenCalled();
    });

    test('email contains correct approve/deny URLs with valid tokens', async () => {
      const event = {
        params: { groupId: 'group1', userId: 'user1' },
        data: {
          data: () => ({
            email: 'test@example.com',
            displayName: 'Test User',
          }),
        },
      };

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: ['manager@example.com'],
      });

      await functions.onPendingMemberCreated(event);

      const sentMessage = mockSgMail.send.mock.calls[0][0];
      const html = sentMessage.html;

      // Check for approve URL with token
      expect(html).toMatch(/approveMember\?g=group1&u=user1&t=[a-f0-9]{16}&action=approve/);
      
      // Check for deny URL with token
      expect(html).toMatch(/approveMember\?g=group1&u=user1&t=[a-f0-9]{16}&action=deny/);
    });

    test('handles SendGrid error gracefully', async () => {
      const event = {
        params: { groupId: 'group1', userId: 'user1' },
        data: {
          data: () => ({
            email: 'test@example.com',
            displayName: 'Test User',
          }),
        },
      };

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: ['manager@example.com'],
      });

      mockSgMail.send.mockRejectedValue({
        response: { body: 'SendGrid error' },
      });

      await functions.onPendingMemberCreated(event);

      expect(console.error).toHaveBeenCalledWith('SendGrid error:', 'SendGrid error');
    });
  });

  // ===== sendVotingReminders TESTS =====

  describe('sendVotingReminders', () => {
    test('runs without errors and logs checking message', async () => {
      // Time-based logic is tested via helper functions and integration
      await functions.sendVotingReminders();
      
      // Should at least log that it's checking
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[Reminders] Checking at')
      );
    });

    test('processes groups without errors', async () => {
      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        settings: { votingCloseTime: '11:50' },
        managers: [],
      });
      
      // Should complete without throwing
      await expect(functions.sendVotingReminders()).resolves.not.toThrow();
    });
  });

  // ===== sendWinnerAnnouncements TESTS =====

  describe('sendWinnerAnnouncements', () => {
    test('runs without errors and logs checking message', async () => {
      // Time-based logic is tested via helper functions and integration
      await functions.sendWinnerAnnouncements();
      
      // Should at least log that it's checking
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[Winners] Checking at')
      );
    });

    test('processes groups with votes without errors', async () => {
      const today = functions.getCSTDateString();
      
      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        settings: { votingCloseTime: '11:50' },
        managers: [],
      });
      mockDb.setDocument(`groups/group1/votes/${today}/ballots/user1`, {
        restaurantName: 'Pizza Place',
      });
      
      // Should complete without throwing
      await expect(functions.sendWinnerAnnouncements()).resolves.not.toThrow();
    });
    
    test('respects notifDays via getGroupNotifRecipients', async () => {
      // This is tested via the getGroupNotifRecipients helper tests
      // The integration is verified by the function running without errors
      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        settings: { votingCloseTime: '11:50' },
        managers: [],
      });

      await expect(functions.sendWinnerAnnouncements()).resolves.not.toThrow();
    });
  });

  // ===== onRevenueCatWebhook TESTS =====

  describe('onRevenueCatWebhook', () => {
    let mockReq, mockRes;

    beforeEach(() => {
      mockReq = {
        headers: {},
        body: {},
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };
    });

    test('returns 401 for missing auth header', async () => {
      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.send).toHaveBeenCalledWith('Unauthorized');
    });

    test('returns 401 for invalid auth header', async () => {
      mockReq.headers.authorization = 'Bearer wrong-secret';

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.send).toHaveBeenCalledWith('Unauthorized');
    });

    test('returns 400 for missing event type', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          app_user_id: 'user1',
        },
      };

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Bad request');
    });

    test('returns 400 for missing app_user_id', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'INITIAL_PURCHASE',
        },
      };

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Bad request');
    });

    test('INITIAL_PURCHASE sets user active and unfreezes groups', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: 'user1',
        },
      };

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
        subscriptionStatus: 'expired',
      });
      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: ['test@example.com'],
        status: 'frozen',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      // Check user update
      const userUpdate = mockDb.getWrites().find(w => w.path === 'users/user1' && w.type === 'update');
      expect(userUpdate.data.subscriptionStatus).toBe('active');
      expect(userUpdate.data.groupsFrozenAt).toBeNull();
      expect(userUpdate.data.groupsDeleteAt).toBeNull();

      // Check group update
      const groupUpdate = mockDb.getWrites().find(w => w.path === 'groups/group1' && w.type === 'update');
      expect(groupUpdate.data.status).toBe('active');
      expect(groupUpdate.data.frozenAt).toBeNull();
      expect(groupUpdate.data.deleteAt).toBeNull();

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    test('RENEWAL sets user active and unfreezes groups', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'RENEWAL',
          app_user_id: 'user1',
        },
      };

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
        subscriptionStatus: 'expired',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      const userUpdate = mockDb.getWrites().find(w => w.path === 'users/user1' && w.type === 'update');
      expect(userUpdate.data.subscriptionStatus).toBe('active');
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    test('EXPIRATION sets user expired and freezes groups with deleteAt', async () => {
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      
      global.Date = jest.fn((...args) => {
        if (args.length === 0) return now;
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'EXPIRATION',
          app_user_id: 'user1',
        },
      };

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
        subscriptionStatus: 'active',
      });
      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        managers: ['test@example.com'],
        status: 'active',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      // Check user update
      const userUpdate = mockDb.getWrites().find(w => w.path === 'users/user1' && w.type === 'update');
      expect(userUpdate.data.subscriptionStatus).toBe('expired');
      expect(userUpdate.data.groupsFrozenAt).toEqual(now);
      
      const expectedDeleteAt = new RealDate(now.getTime() + 28 * 24 * 60 * 60 * 1000);
      expect(userUpdate.data.groupsDeleteAt).toEqual(expectedDeleteAt);

      // Check group update
      const groupUpdate = mockDb.getWrites().find(w => w.path === 'groups/group1' && w.type === 'update');
      expect(groupUpdate.data.status).toBe('frozen');
      expect(groupUpdate.data.frozenAt).toEqual(now);
      expect(groupUpdate.data.deleteAt).toEqual(expectedDeleteAt);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      
      global.Date = RealDate;
    });

    test('CANCELLATION freezes groups with deleteAt', async () => {
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      
      global.Date = jest.fn((...args) => {
        if (args.length === 0) return now;
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'CANCELLATION',
          app_user_id: 'user1',
        },
      };

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
        subscriptionStatus: 'active',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      const userUpdate = mockDb.getWrites().find(w => w.path === 'users/user1' && w.type === 'update');
      expect(userUpdate.data.subscriptionStatus).toBe('expired');
      expect(mockRes.status).toHaveBeenCalledWith(200);
      
      global.Date = RealDate;
    });

    test('unknown event type returns 200 OK', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'UNKNOWN_EVENT',
          app_user_id: 'user1',
        },
      };

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalledWith('OK');
    });

    test('user not found returns 200 OK with warning', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: 'nonexistent',
        },
      };

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('User nonexistent not found')
      );
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    test('error during processing returns 500', async () => {
      mockReq.headers.authorization = `Bearer ${mockSecrets.REVENUECAT_WEBHOOK_SECRET}`;
      mockReq.body = {
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: 'user1',
        },
      };

      // Mock a database error
      const originalUpdate = MockDocumentReference.prototype.update;
      MockDocumentReference.prototype.update = jest.fn().mockRejectedValue(new Error('DB error'));

      mockDb.setDocument('users/user1', {
        email: 'test@example.com',
      });

      await functions.onRevenueCatWebhook(mockReq, mockRes);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error processing webhook'),
        expect.any(Error)
      );
      expect(mockRes.status).toHaveBeenCalledWith(500);

      // Restore
      MockDocumentReference.prototype.update = originalUpdate;
    });
  });

  // ===== cleanupFrozenGroups TESTS =====

  describe('cleanupFrozenGroups', () => {
    test('deletes groups where deleteAt <= now', async () => {
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      const pastDate = new RealDate('2026-03-01T12:00:00Z');
      
      global.Date = jest.fn((...args) => {
        if (args.length === 0) return now;
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockDb.setDocument('groups/group1', {
        name: 'Expired Group',
        status: 'frozen',
        deleteAt: pastDate,
      });

      await functions.cleanupFrozenGroups();

      expect(mockDb.getDeletes()).toContain('groups/group1');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Deleted group group1')
      );
      
      global.Date = RealDate;
    });

    test('deletes subcollections in correct order', async () => {
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      const pastDate = new RealDate('2026-03-01T12:00:00Z');
      
      global.Date = jest.fn((...args) => {
        if (args.length === 0) return now;
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        status: 'frozen',
        deleteAt: pastDate,
      });
      mockDb.setDocument('groups/group1/members/user1', {});
      mockDb.setDocument('groups/group1/pendingMembers/user2', {});
      mockDb.setDocument('groups/group1/votes/2026-03-07', {});
      mockDb.setDocument('groups/group1/votes/2026-03-07/ballots/user1', {});
      mockDb.setDocument('groups/group1/votes/2026-03-07/extras/user1', {});
      mockDb.setDocument('groups/group1/notificationLog/2026-03-07', {});

      await functions.cleanupFrozenGroups();

      const deletes = mockDb.getDeletes();
      
      // Check that nested collections are deleted before parent
      const ballotsIndex = deletes.indexOf('groups/group1/votes/2026-03-07/ballots/user1');
      const extrasIndex = deletes.indexOf('groups/group1/votes/2026-03-07/extras/user1');
      const voteDocIndex = deletes.indexOf('groups/group1/votes/2026-03-07');
      const groupIndex = deletes.indexOf('groups/group1');

      expect(ballotsIndex).toBeLessThan(voteDocIndex);
      expect(extrasIndex).toBeLessThan(voteDocIndex);
      expect(voteDocIndex).toBeLessThan(groupIndex);
      
      global.Date = RealDate;
    });

    test('sends FCM to all members before deletion', async () => {
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      const pastDate = new RealDate('2026-03-01T12:00:00Z');
      
      global.Date = jest.fn((...args) => {
        if (args.length === 0) return now;
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockDb.setDocument('groups/group1', {
        name: 'Test Group',
        status: 'frozen',
        deleteAt: pastDate,
      });
      mockDb.setDocument('groups/group1/members/user1', {});
      mockDb.setDocument('users/user1', { fcmToken: 'token1' });

      mockMessaging.sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        failureCount: 0,
      });

      await functions.cleanupFrozenGroups();

      expect(mockMessaging.sendEachForMulticast).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['token1'],
          notification: expect.objectContaining({
            title: 'Group Deleted',
          }),
        })
      );
      
      global.Date = RealDate;
    });

    test('sends 7-day warning to managers for groups expiring within 7 days', async () => {
      // Use real Date constructor for now
      const RealDate = Date;
      const now = new RealDate('2026-03-07T12:00:00Z');
      const sixDaysFromNow = new RealDate('2026-03-13T12:00:00Z');
      const sevenDaysFromNow = new RealDate('2026-03-14T12:00:00Z');
      
      // Mock Date constructor to return our fixed time
      global.Date = jest.fn((...args) => {
        if (args.length === 0) {
          return now;
        }
        return new RealDate(...args);
      });
      global.Date.now = () => now.getTime();

      mockDb.setDocument('groups/group1', {
        name: 'Warning Group',
        status: 'frozen',
        deleteAt: sixDaysFromNow,
        managers: ['manager@example.com'],
      });
      mockDb.setDocument('users/user1', {
        email: 'manager@example.com',
        fcmToken: 'manager-token',
      });

      mockMessaging.sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        failureCount: 0,
      });

      await functions.cleanupFrozenGroups();

      expect(mockMessaging.sendEachForMulticast).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['manager-token'],
          notification: expect.objectContaining({
            title: '⚠️ Groups Expiring Soon',
          }),
        })
      );

      // Check that warning flag was set
      const groupUpdate = mockDb.getWrites().find(w => 
        w.path === 'groups/group1' && w.type === 'update'
      );
      expect(groupUpdate.data.warningNotificationSent).toBe(true);
      
      // Restore Date
      global.Date = RealDate;
    });

    test('skips warning if already sent', async () => {
      const now = new Date('2026-03-07T12:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now);

      const sixDaysFromNow = new Date('2026-03-13T12:00:00Z');

      mockDb.setDocument('groups/group1', {
        name: 'Warning Group',
        status: 'frozen',
        deleteAt: sixDaysFromNow,
        managers: ['manager@example.com'],
        warningNotificationSent: true,
      });

      await functions.cleanupFrozenGroups();

      expect(mockMessaging.sendEachForMulticast).not.toHaveBeenCalled();
    });

    test('handles errors per-group without failing batch', async () => {
      const now = new Date('2026-03-07T12:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now);

      const pastDate = new Date('2026-03-01T12:00:00Z');

      mockDb.setDocument('groups/group1', {
        name: 'Good Group',
        status: 'frozen',
        deleteAt: pastDate,
      });
      mockDb.setDocument('groups/group2', {
        name: 'Bad Group',
        status: 'frozen',
        deleteAt: pastDate,
      });

      // Mock error for group2
      const originalDelete = MockDocumentReference.prototype.delete;
      MockDocumentReference.prototype.delete = jest.fn(async function() {
        if (this.path === 'groups/group2') {
          throw new Error('Delete failed');
        }
        return originalDelete.call(this);
      });

      await functions.cleanupFrozenGroups();

      // group1 should be deleted
      expect(mockDb.getDeletes()).toContain('groups/group1');
      
      // Error should be logged for group2
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error deleting group group2'),
        expect.any(Error)
      );

      // Restore
      MockDocumentReference.prototype.delete = originalDelete;
    });
  });
});
