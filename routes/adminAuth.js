/**
 * ============================================================
 * FacialPass AI — Admin Auth Routes
 * ============================================================
 *
 * Endpoints:
 *   POST /admin/register   → Validate CAPTCHA → hash pw → create admin → send OTP
 *   POST /admin/verify-otp → Verify 6-digit OTP → set isVerified: true
 *   POST /admin/login      → Check email/password → return admin profile
 *   POST /admin/resend-otp → Rate-limited OTP resend (60s cooldown)
 *   POST /clear-logs       → Batch delete all log documents
 *
 * Uses Nodemailer with Gmail App Password for OTP delivery.
 *
 * Environment Variables Required:
 *   SMTP_USER — Gmail address (e.g. yourapp@gmail.com)
 *   SMTP_PASS — Gmail App Password (16-char code from Google)
 *   RECAPTCHA_SECRET — Google reCAPTCHA v3 secret key (optional for now)
 *
 * ============================================================
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ── SMTP Transporter (Gmail) ──
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
  console.warn('⚠️  Nodemailer transporter not configured. OTP emails will not send.');
}

/**
 * Generates a 6-digit OTP code
 */
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Simple password hashing using SHA-256 + salt.
 * In production, use bcrypt or argon2.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const computed = crypto.createHash('sha256').update(password + salt).digest('hex');
  return computed === hash;
}

/**
 * Sends a 6-digit OTP email
 */
async function sendOTPEmail(email, otp, adminName) {
  if (!transporter || !process.env.SMTP_USER) {
    console.warn(`  ⚠️  SMTP not configured. OTP for ${email}: ${otp}`);
    return; // Fail silently — OTP is logged to console for dev
  }

  const mailOptions = {
    from: `"FacialPass AI" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Your FacialPass AI Verification Code',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <div style="width: 56px; height: 56px; background: #E8F5E9; border-radius: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 28px;">🔐</div>
          <h2 style="color: #1A1A2E; margin-top: 16px; font-size: 22px;">FacialPass AI</h2>
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
          If you didn't request this, please ignore this email.
        </p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
  console.log(`  📧 OTP email sent to ${email}`);
}

/**
 * Registers all admin auth routes on the Express app.
 *
 * @param {Express} app - Express app instance
 * @param {Firestore} db - Firestore database instance
 */
function registerAdminRoutes(app, db) {
  // ═════════════════════════════════════════════════════════
  //  POST /admin/register
  //  Create admin → Generate OTP → Send email
  // ═════════════════════════════════════════════════════════
  app.post('/admin/register', async (req, res) => {
    try {
      const { name, schoolName, email, password, captchaToken } = req.body;

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

      // ── reCAPTCHA v3 Validation (scaffolded for later) ──
      // TODO: Uncomment when you have a reCAPTCHA secret key
      // if (captchaToken && process.env.RECAPTCHA_SECRET) {
      //   const captchaRes = await fetch(
      //     `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${captchaToken}`
      //   );
      //   const captchaData = await captchaRes.json();
      //   if (!captchaData.success || captchaData.score < 0.5) {
      //     return res.status(403).json({
      //       success: false,
      //       error: 'CAPTCHA verification failed. Please try again.',
      //     });
      //   }
      // }

      console.log(`\n🔐 Admin registration: ${name} (${email})`);

      // Check if admin already exists
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
        // Unverified — allow re-registration
        console.log('  ♻️  Overwriting unverified admin record');
      }

      // Hash password
      const { hash, salt } = hashPassword(password);

      // Generate OTP
      const otp = generateOTP();
      const otpExpiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

      // Save to Firestore
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

      console.log(`  💾 Admin saved to Firestore: admins/${docId}`);
      console.log(`  🔑 OTP: ${otp} (expires in 5 min)`);

      // Send OTP email
      try {
        await sendOTPEmail(email, otp, name);
      } catch (emailErr) {
        console.warn('  ⚠️  Failed to send OTP email:', emailErr.message);
        // Don't fail registration — OTP is logged to console
      }

      res.json({
        success: true,
        message: 'Account created. Please verify your email.',
        email: email.toLowerCase(),
      });
    } catch (error) {
      console.error('❌ Admin registration error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during registration.',
      });
    }
  });

  // ═════════════════════════════════════════════════════════
  //  POST /admin/verify-otp
  //  Verify the 6-digit code → set isVerified: true
  // ═════════════════════════════════════════════════════════
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

      // Check OTP expiry
      if (Date.now() > data.otpExpiresAt) {
        return res.status(410).json({
          success: false,
          error: 'OTP has expired. Please request a new one.',
        });
      }

      // Check OTP match
      if (data.otp !== otp) {
        return res.status(401).json({
          success: false,
          error: 'Invalid OTP. Please try again.',
        });
      }

      // Mark as verified
      await db.collection('admins').doc(docId).update({
        isVerified: true,
        otp: null,
        otpExpiresAt: null,
      });

      console.log(`  ✅ Admin verified: ${email}`);

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
      console.error('❌ OTP verification error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during OTP verification.',
      });
    }
  });

  // ═════════════════════════════════════════════════════════
  //  POST /admin/login
  //  Check email/password → return admin profile
  // ═════════════════════════════════════════════════════════
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

      // Verify password
      if (!verifyPassword(password, data.passwordHash, data.passwordSalt)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password.',
        });
      }

      // Check verification status
      if (!data.isVerified) {
        return res.status(403).json({
          success: false,
          error: 'Email not verified. Please verify your email first.',
          needsVerification: true,
          email: data.email,
        });
      }

      console.log(`  🔓 Admin login: ${data.name} (${email})`);

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
      console.error('❌ Admin login error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error during login.',
      });
    }
  });

  // ═════════════════════════════════════════════════════════
  //  POST /admin/resend-otp
  //  Rate-limited OTP resend (60s cooldown)
  // ═════════════════════════════════════════════════════════
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

      // Rate limit: 60 seconds
      const timeSinceLastOTP = Date.now() - (data.lastOtpSentAt || 0);
      if (timeSinceLastOTP < 60000) {
        const waitSeconds = Math.ceil((60000 - timeSinceLastOTP) / 1000);
        return res.status(429).json({
          success: false,
          error: `Please wait ${waitSeconds} seconds before requesting a new code.`,
          waitSeconds,
        });
      }

      // Generate new OTP
      const otp = generateOTP();
      const otpExpiresAt = Date.now() + 5 * 60 * 1000;

      await db.collection('admins').doc(docId).update({
        otp,
        otpExpiresAt,
        lastOtpSentAt: Date.now(),
      });

      console.log(`  🔑 New OTP for ${email}: ${otp}`);

      // Send email
      try {
        await sendOTPEmail(email, otp, data.name);
      } catch (emailErr) {
        console.warn('  ⚠️  Failed to send OTP email:', emailErr.message);
      }

      res.json({
        success: true,
        message: 'New verification code sent.',
      });
    } catch (error) {
      console.error('❌ Resend OTP error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error resending OTP.',
      });
    }
  });

  // ═════════════════════════════════════════════════════════
  //  POST /clear-logs
  //  Batch delete all docs in the logs collection
  // ═════════════════════════════════════════════════════════
  app.post('/clear-logs', async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          success: false,
          error: 'Database not connected.',
        });
      }

      console.log('\n🗑️  Clearing all access logs...');

      const snapshot = await db.collection('logs').get();
      const batchSize = snapshot.size;

      if (batchSize === 0) {
        return res.json({
          success: true,
          message: 'No logs to clear.',
          deleted: 0,
        });
      }

      // Firestore batches support max 500 operations
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

      console.log(`  ✅ Deleted ${batchSize} log(s)`);

      res.json({
        success: true,
        message: `Cleared ${batchSize} log(s).`,
        deleted: batchSize,
      });
    } catch (error) {
      console.error('❌ Clear logs error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error clearing logs.',
      });
    }
  });

  // ═════════════════════════════════════════════════════════
  //  POST /admin/reset-password
  //  Verify OTP and set new password
  // ═════════════════════════════════════════════════════════
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

      // Check OTP expiry
      if (!data.otpExpiresAt || Date.now() > data.otpExpiresAt) {
        return res.status(410).json({
          success: false,
          error: 'OTP has expired. Please request a new one.',
        });
      }

      // Check OTP match
      if (data.otp !== otp) {
        return res.status(401).json({
          success: false,
          error: 'Invalid OTP. Please try again.',
        });
      }

      // Hash new password
      const { hash, salt } = hashPassword(newPassword);

      // Update password and clear OTP
      await db.collection('admins').doc(docId).update({
        passwordHash: hash,
        passwordSalt: salt,
        otp: null,
        otpExpiresAt: null,
        isVerified: true, // Also ensure they are verified if they reset
      });

      console.log(`  🔑 Password reset successful for: ${email}`);

      res.json({
        success: true,
        message: 'Password reset successfully.',
      });
    } catch (error) {
      console.error('❌ Reset password error:', error.message);
      res.status(500).json({
        success: false,
        error: 'Server error resetting password.',
      });
    }
  });
}

module.exports = { registerAdminRoutes };
