const assert = require('node:assert/strict');
const { test } = require('node:test');
const nodemailer = require('nodemailer');

// A dependency compatibility check outside the application's transport boundary.
// The stream transport serializes locally and never opens an SMTP connection.
test('Nodemailer builds a threaded UTF-8 reply', async () => {
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    try {
        const result = await transporter.sendMail({
            from: '"PiPi Bot" <pipi@example.test>',
            to: 'Owner <owner@example.test>',
            subject: 'Re: Привет',
            text: 'Готово!',
            textEncoding: 'base64',
            inReplyTo: '<thread@example.test>',
            references: ['<first@example.test>', '<thread@example.test>'],
        });
        const message = result.message.toString();
        assert.deepEqual(result.envelope, { from: 'pipi@example.test', to: ['owner@example.test'] });
        assert.ok(result.messageId);
        assert.ok(message.includes('In-Reply-To: <thread@example.test>'));
        assert.ok(message.includes('References: <first@example.test> <thread@example.test>'));
        assert.ok(message.includes('Content-Type: text/plain; charset=utf-8'));
        assert.ok(message.includes(Buffer.from('Готово!').toString('base64')));
    } finally {
        transporter.close();
    }
});
