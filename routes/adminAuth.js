const crypto = require('crypto');
const nodemailer = require('nodemailer');

let transporter = null;
try {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  });
} catch (err) {
  console.warn('[WARNING] Nodemailer transporter not configured. OTP emails will not send.');
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const computed = crypto.createHash('sha256').update(password + salt).digest('hex');
  return computed === hash;
}

async function sendOTPEmail(email, otp, adminName) {
  if (!transporter || !process.env.SMTP_USER) {
    console.warn(`[WARNING] SMTP not configured. OTP for ${email}: ${otp}`);
    return;
  }

  const mailOptions = {
    from: `"FacialPass Admin" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Your Verification Code',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #1A1A2E; margin-top: 16px; font-size: 22px;">FacialPass API</h2>
        </div>
        <p style="color: #374151; font-size: 15px; line-height: 1.6;">
          Hi ${adminName || 'Admin'},<br><br>
          Your verification code is:
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <div style="display: inline-block; background: #F8F9FA; border: 2px solid #E5E7EB; border-radius: 12px; padding: 16px 32px;">
            <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #2E7D32;">${otp}</span>
          </div>
        </div>
        <p style="color: #6B7280; font-size: 13px; text-align: center;">
          This code expires in <strong>5 minutes</strong>.<br>
          If you did not request this, please ignore this email.
        </p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
  console.log(`[MAIL] OTP email sent to ${email}`);
}

function registerAdminRoutes(app, db) {
  // POST /admin/register
  app.post('/admin/register', async (req, res) => {
    try {
      const { name, schoolName, email, password } = req.body;

      if (!name || !email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Name, email, and password are required.',
        });
      }

      if (!db) {
        return res.status(503).json({
          success: false,
          error: 'Database not connected.',
        });
      }

      console.log(`[AUTH] Admin registration: ${name} (${email})`);

      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const existing = await db.collection('admins').doc(docId).get();

      if (existing.exists) {
        const existingData = existing.data();
        if (existingData.isVerified) {
          return res.status(409).json({
            success: false,
            error: 'An account with this email already exists.',
          });
        }
        console.log('[AUTH] Overwriting unverified admin record');
      }

      const { hash, salt } = hashPassword(password);
      const otp = generateOTP();
      const otpExpiresAt = Date.now() + 5 * 60 * 1000;

      await db.collection('admins').doc(docId).set({
        name,
        schoolName: schoolName || '',
        email: email.toLowerCase(),
        passwordHash: hash,
        passwordSalt: salt,
        otp,
        otpExpiresAt,
        lastOtpSentAt: Date.now(),
        isVerified: false,
        role: 'admin',
        createdAt: Date.now(),
      });

      console.log(`[DB] Admin saved to Firestore: admins/${docId}`);
      console.log(`[AUTH] Generated OTP: ${otp}`);

      try {
        await sendOTPEmail(email, otp, name);
      } catch (emailErr) {
        console.warn('[WARNING] Failed to send OTP email:', emailErr.message);
      }

      res.json({
        success: true,
        message: 'Account created. Please verify your email.',
        email: email.toLowerCase(),
      });
    } catch (error) {
      console.error('[ERROR] Admin registration error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during registration.',
      });
    }
  });

  // POST /admin/verify-otp
  app.post('/admin/verify-otp', async (req, res) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({
          success: false,
          error: 'Email and OTP are required.',
        });
      }

      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();

      if (!doc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Account not found. Please register first.',
        });
      }

      const data = doc.data();

      if (Date.now() > data.otpExpiresAt) {
        return res.status(410).json({
          success: false,
          error: 'OTP has expired. Please request a new one.',
        });
      }

      if (data.otp !== otp) {
        return res.status(401).json({
          success: false,
          error: 'Invalid OTP. Please try again.',
        });
      }

      await db.collection('admins').doc(docId).update({
        isVerified: true,
        otp: null,
        otpExpiresAt: null,
      });

      console.log(`[AUTH] Admin verified: ${email}`);

      res.json({
        success: true,
        message: 'Email verified successfully.',
        admin: {
          name: data.name,
          schoolName: data.schoolName,
          email: data.email,
          role: data.role,
          isVerified: true,
        },
      });
    } catch (error) {
      console.error('[ERROR] OTP verification error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during OTP verification.',
      });
    }
  });

  // POST /admin/login
  app.post('/admin/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Email and password are required.',
        });
      }

      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();

      if (!doc.exists) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password.',
        });
      }

      const data = doc.data();

      if (!verifyPassword(password, data.passwordHash, data.passwordSalt)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password.',
        });
      }

      if (!data.isVerified) {
        return res.status(403).json({
          success: false,
          error: 'Email not verified. Please verify your email first.',
          needsVerification: true,
          email: data.email,
        });
      }

      console.log(`[AUTH] Admin login: ${data.name} (${email})`);

      res.json({
        success: true,
        admin: {
          name: data.name,
          schoolName: data.schoolName,
          email: data.email,
          role: data.role,
          isVerified: true,
        },
      });
    } catch (error) {
      console.error('[ERROR] Admin login error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during login.',
      });
    }
  });

  // POST /admin/resend-otp
  app.post('/admin/resend-otp', async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required.',
        });
      }

      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();

      if (!doc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Account not found.',
        });
      }

      const data = doc.data();

      const timeSinceLastOTP = Date.now() - (data.lastOtpSentAt || 0);
      if (timeSinceLastOTP < 60000) {
        const waitSeconds = Math.ceil((60000 - timeSinceLastOTP) / 1000);
        return res.status(429).json({
          success: false,
          error: `Please wait ${waitSeconds} seconds before requesting a new code.`,
          waitSeconds,
        });
      }

      const otp = generateOTP();
      const otpExpiresAt = Date.now() + 5 * 60 * 1000;

      await db.collection('admins').doc(docId).update({
        otp,
        otpExpiresAt,
        lastOtpSentAt: Date.now(),
      });

      console.log(`[AUTH] New OTP for ${email}: ${otp}`);

      try {
        await sendOTPEmail(email, otp, data.name);
      } catch (emailErr) {
        console.warn('[WARNING] Failed to send OTP email:', emailErr.message);
      }

      res.json({
        success: true,
        message: 'New verification code sent.',
      });
    } catch (error) {
      console.error('[ERROR] Resend OTP error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error resending OTP.',
      });
    }
  });

  // POST /clear-logs
  app.post('/clear-logs', async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          success: false,
          error: 'Database not connected.',
        });
      }

      console.log('[DB] Batch clearing transactional logs...');

      const collections = ['attendance_logs', 'leave_requests', 'daily_reports', 'logs'];
      let totalDeleted = 0;

      for (const coll of collections) {
        const snapshot = await db.collection(coll).get();
        const size = snapshot.size;
        if (size > 0) {
          const batches = [];
          let currentBatch = db.batch();
          let count = 0;

          snapshot.forEach((doc) => {
            currentBatch.delete(doc.ref);
            count++;
            if (count % 500 === 0) {
              batches.push(currentBatch);
              currentBatch = db.batch();
            }
          });

          if (count % 500 !== 0) {
            batches.push(currentBatch);
          }

          await Promise.all(batches.map((b) => b.commit()));
          totalDeleted += size;
          console.log(`[DB] Cleared collection: ${coll} (${size} docs)`);
        }
      }

      res.json({
        success: true,
        message: 'All history, notifications, leave requests, and reports cleared successfully.',
        deleted: totalDeleted,
      });
    } catch (error) {
      console.error('[ERROR] Clear logs error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error clearing logs: ' + error.message,
      });
    }
  });

  // POST /admin/reset-password
  app.post('/admin/reset-password', async (req, res) => {
    try {
      const { email, otp, newPassword } = req.body;

      if (!email || !otp || !newPassword) {
        return res.status(400).json({
          success: false,
          error: 'Email, OTP, and new password are required.',
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'New password must be at least 6 characters.',
        });
      }

      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();

      if (!doc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Account not found.',
        });
      }

      const data = doc.data();

      if (!data.otpExpiresAt || Date.now() > data.otpExpiresAt) {
        return res.status(410).json({
          success: false,
          error: 'OTP has expired. Please request a new one.',
        });
      }

      if (data.otp !== otp) {
        return res.status(401).json({
          success: false,
          error: 'Invalid OTP. Please try again.',
        });
      }

      const { hash, salt } = hashPassword(newPassword);

      await db.collection('admins').doc(docId).update({
        passwordHash: hash,
        passwordSalt: salt,
        otp: null,
        otpExpiresAt: null,
        isVerified: true,
      });

      console.log(`[AUTH] Password reset successful for: ${email}`);

      res.json({
        success: true,
        message: 'Password reset successfully.',
      });
    } catch (error) {
      console.error('[ERROR] Reset password error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error resetting password.',
      });
    }
  });

  // POST /api/admin/verify-session
  app.post('/api/admin/verify-session', async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required.' });
      }
      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();
      if (!doc.exists || !doc.data().isVerified) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
      }
      res.json({ success: true, message: 'Session is valid.' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/admin/verify-password
  app.post('/api/admin/verify-password', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
      }
      const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const doc = await db.collection('admins').doc(docId).get();
      if (!doc.exists) {
        return res.status(401).json({ success: false, error: 'Authentication failed.' });
      }
      const data = doc.data();
      if (!verifyPassword(password, data.passwordHash, data.passwordSalt)) {
        return res.status(401).json({ success: false, error: 'Incorrect password.' });
      }
      res.json({ success: true, message: 'Password verified.' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = { registerAdminRoutes };
