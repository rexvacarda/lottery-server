// sendgrid.js
const sgMail = require('@sendgrid/mail');

// Load API key from environment variable on Render
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Universal send function
async function sendEmail({ to, subject, html }) {
  const msg = {
    to,
    from: {
      email: 'info@smelltoimpress.com', // VERIFIED SENDER
      name: 'SmellToImpress'
    },
    subject,
    html,
  };

  try {
    await sgMail.send(msg);
    console.log(`Email sent → ${to}`);
  } catch (error) {
    console.error('SendGrid Error:', error.response?.body || error);
  }
}

module.exports = { sendEmail };
