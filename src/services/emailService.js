// backend/src/services/emailService.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Email configuration
const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev'; // Use support@gambino.gold once domain verified
const APP_NAME = 'Gambino Gold';
const APP_URL = process.env.FRONTEND_URL || 'https://app.gambino.gold';

/**
 * Send email verification link
 */
async function sendVerificationEmail(email, firstName, verificationToken) {
  const verificationUrl = `${APP_URL}/verify-email?token=${verificationToken}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Verify your ${APP_NAME} account`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <table role="presentation" style="width: 100%; border-collapse: collapse;">
            <tr>
              <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #1a1a1a; border-radius: 12px; overflow: hidden;">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%);">
                      <h1 style="margin: 0; color: #0a0a0a; font-size: 28px; font-weight: bold;">🎰 ${APP_NAME}</h1>
                    </td>
                  </tr>

                  <!-- Content -->
                  <tr>
                    <td style="padding: 40px;">
                      <h2 style="margin: 0 0 20px; color: #ffffff; font-size: 24px;">Welcome, ${firstName}!</h2>
                      <p style="margin: 0 0 20px; color: #cccccc; font-size: 16px; line-height: 1.6;">
                        Thanks for signing up for ${APP_NAME}. Please verify your email address to activate your account and start earning rewards.
                      </p>

                      <!-- CTA Button -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td align="center" style="padding: 20px 0;">
                            <a href="${verificationUrl}" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 100%); color: #0a0a0a; text-decoration: none; font-weight: bold; font-size: 16px; border-radius: 8px;">
                              Verify Email Address
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="margin: 20px 0 0; color: #888888; font-size: 14px; line-height: 1.6;">
                        Or copy and paste this link into your browser:
                      </p>
                      <p style="margin: 10px 0 0; color: #d4af37; font-size: 14px; word-break: break-all;">
                        ${verificationUrl}
                      </p>

                      <p style="margin: 30px 0 0; color: #666666; font-size: 13px;">
                        This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
                      </p>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="padding: 20px 40px; background-color: #111111; text-align: center;">
                      <p style="margin: 0; color: #666666; font-size: 12px;">
                        © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `
Welcome to ${APP_NAME}, ${firstName}!

Please verify your email address by clicking the link below:

${verificationUrl}

This link expires in 24 hours.

If you didn't create an account, you can safely ignore this email.

- The ${APP_NAME} Team
      `.trim()
    });

    if (error) {
      console.error('❌ Resend error:', error);
      throw new Error(error.message);
    }

    console.log(`📧 Verification email sent to ${email} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error('❌ Failed to send verification email:', err);
    throw err;
  }
}

/**
 * Send password reset email
 */
async function sendPasswordResetEmail(email, firstName, resetToken) {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Reset your ${APP_NAME} password`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <table role="presentation" style="width: 100%; border-collapse: collapse;">
            <tr>
              <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #1a1a1a; border-radius: 12px; overflow: hidden;">
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%);">
                      <h1 style="margin: 0; color: #0a0a0a; font-size: 28px; font-weight: bold;">🎰 ${APP_NAME}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 40px;">
                      <h2 style="margin: 0 0 20px; color: #ffffff; font-size: 24px;">Password Reset Request</h2>
                      <p style="margin: 0 0 20px; color: #cccccc; font-size: 16px; line-height: 1.6;">
                        Hi ${firstName}, we received a request to reset your password. Click the button below to create a new password.
                      </p>
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td align="center" style="padding: 20px 0;">
                            <a href="${resetUrl}" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 100%); color: #0a0a0a; text-decoration: none; font-weight: bold; font-size: 16px; border-radius: 8px;">
                              Reset Password
                            </a>
                          </td>
                        </tr>
                      </table>
                      <p style="margin: 20px 0 0; color: #888888; font-size: 14px;">
                        Or copy this link: <span style="color: #d4af37;">${resetUrl}</span>
                      </p>
                      <p style="margin: 30px 0 0; color: #666666; font-size: 13px;">
                        This link expires in 1 hour. If you didn't request this, please ignore this email.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 20px 40px; background-color: #111111; text-align: center;">
                      <p style="margin: 0; color: #666666; font-size: 12px;">
                        © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `
Password Reset Request

Hi ${firstName},

We received a request to reset your ${APP_NAME} password. Click the link below to create a new password:

${resetUrl}

This link expires in 1 hour. If you didn't request this, please ignore this email.

- The ${APP_NAME} Team
      `.trim()
    });

    if (error) {
      console.error('❌ Resend error:', error);
      throw new Error(error.message);
    }

    console.log(`📧 Password reset email sent to ${email} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error('❌ Failed to send password reset email:', err);
    throw err;
  }
}

/**
 * Send welcome email after verification
 */
async function sendWelcomeEmail(email, firstName) {
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Welcome to ${APP_NAME}! 🎰`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
          <table role="presentation" style="width: 100%; border-collapse: collapse;">
            <tr>
              <td align="center" style="padding: 40px 0;">
                <table role="presentation" style="width: 600px; max-width: 100%; border-collapse: collapse; background-color: #1a1a1a; border-radius: 12px; overflow: hidden;">
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%);">
                      <h1 style="margin: 0; color: #0a0a0a; font-size: 28px; font-weight: bold;">🎰 ${APP_NAME}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 40px; text-align: center;">
                      <h2 style="margin: 0 0 20px; color: #ffffff; font-size: 24px;">You're all set, ${firstName}! 🎉</h2>
                      <p style="margin: 0 0 30px; color: #cccccc; font-size: 16px; line-height: 1.6;">
                        Your email has been verified and your account is now active. Start playing and earning Glück Score to unlock amazing rewards!
                      </p>
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <tr>
                          <td align="center">
                            <a href="${APP_URL}/dashboard" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 100%); color: #0a0a0a; text-decoration: none; font-weight: bold; font-size: 16px; border-radius: 8px;">
                              Go to Dashboard
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 20px 40px; background-color: #111111; text-align: center;">
                      <p style="margin: 0; color: #666666; font-size: 12px;">
                        © ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
      text: `
You're all set, ${firstName}! 🎉

Your email has been verified and your ${APP_NAME} account is now active.

Start playing and earning Glück Score to unlock amazing rewards!

Visit your dashboard: ${APP_URL}/dashboard

- The ${APP_NAME} Team
      `.trim()
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return { success: false };
    }

    console.log(`📧 Welcome email sent to ${email} (ID: ${data.id})`);
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error('❌ Failed to send welcome email:', err);
    return { success: false };
  }
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail
};
