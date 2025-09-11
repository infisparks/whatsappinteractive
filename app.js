const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    generateWAMessageFromContent,
    proto
} = require('@fizzxydev/baileys-pro');
const { Boom } = require('@hapi/boom');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');

// Initialize Express app
const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// We need to keep the Baileys socket instance and connection status available globally
let sock;
let isWhatsappConnected = false;

// Main function to connect to WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.resolve(__dirname, 'auth_info_baileys'));

    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("QR Code received, please scan:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isWhatsappConnected = false;
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isWhatsappConnected = true;
            console.log('Opened connection');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (event) => {
        console.log('Received messages:', JSON.stringify(event.messages, null, 2));
    });

    return sock;
}

// Helper function to introduce a delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Endpoint to Send a Simple Text Message ---
app.post('/send-text-message', async (req, res) => {
    const { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ success: false, error: 'Missing jid or text' });
    if (!isWhatsappConnected) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });
    try {
        await sock.sendMessage(jid, { text: text });
        res.status(200).json({ success: true, message: 'Text message sent successfully.' });
    } catch (error) {
        console.error('Error sending text message:', error);
        res.status(500).json({ success: false, error: 'Failed to send text message.' });
    }
});

// --- API Endpoint to Send an INTERACTIVE Message with URL, Reply Buttons, and Optional Media ---
app.post('/send-interactive-message', async (req, res) => {
    const { jid, body, footer, buttons, imageUrl, title, subtitle } = req.body;
    if (!jid || !body || !buttons) return res.status(400).json({ success: false, error: 'Missing required parameters' });
    if (!isWhatsappConnected) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });

    try {
        const interactiveButtons = buttons.map(btn => {
            if (btn.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
            if (btn.type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
            return null;
        }).filter(Boolean);

        if (interactiveButtons.length === 0) return res.status(400).json({ success: false, error: 'No valid buttons provided.' });

        let messageContent = {
            caption: body,
            footer: footer || '',
            title: title || '',
            media: true,
            interactiveButtons: interactiveButtons
        };

        if (imageUrl) {
            messageContent.image = { url: imageUrl };
            messageContent.subtitle = subtitle || '';
        } else {
            delete messageContent.caption;
            messageContent.text = body;
        }

        await sock.sendMessage(jid, messageContent);
        res.status(200).json({ success: true, message: 'Interactive message sent successfully.' });
    } catch (error) {
        console.error('Error sending interactive message:', error);
        res.status(500).json({ success: false, error: 'Failed to send interactive message.' });
    }
});

// --- API Endpoint to Send a Product Message with Header ---
app.post('/send-product-message', async (req, res) => {
    const { jid, businessOwnerJid, product, message, buttons } = req.body;

    if (!jid || !businessOwnerJid || !product || !message || !buttons) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
    if (!isWhatsappConnected) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });
    }

    try {
        const interactiveButtons = buttons.map(btn => {
            if (btn.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
            if (btn.type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
            return null;
        }).filter(Boolean);

        if (interactiveButtons.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid buttons provided.' });
        }

        const messageContent = {
            product: {
                productImage: { url: product.imageUrl },
                productImageCount: 1,
                title: product.title,
                description: product.description,
                priceAmount1000: product.price * 1000,
                currencyCode: product.currencyCode,
                retailerId: product.retailerId || '',
                url: product.url || ''
            },
            businessOwnerJid: businessOwnerJid,
            caption: message.caption,
            title: message.title,
            footer: message.footer,
            media: true,
            interactiveButtons: interactiveButtons
        };

        await sock.sendMessage(jid, messageContent);
        res.status(200).json({ success: true, message: 'Product message sent successfully.' });
    } catch (error) {
        console.error('Error sending product message:', error);
        res.status(500).json({ success: false, error: 'Failed to send product message.' });
    }
});


// --- NEW API Endpoint for Interactive List Message ---
app.post('/send-interactive-list-message', async (req, res) => {
    const { jid, text, footer, buttons } = req.body;

    if (!jid || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing required parameters: jid, text, and at least one button.' });
    }
    if (!isWhatsappConnected) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });
    }

    try {
        const messageContent = {
            text: text,
            footer: footer,
            buttons: buttons.map(btn => {
                let button = {
                    buttonId: btn.buttonId,
                    buttonText: {
                        displayText: btn.buttonText.displayText,
                    },
                    type: btn.type,
                };
                if (btn.nativeFlowInfo) {
                    button.nativeFlowInfo = btn.nativeFlowInfo;
                }
                return button;
            }),
            headerType: 1,
            viewOnce: true,
        };

        await sock.sendMessage(jid, messageContent);
        res.status(200).json({ success: true, message: 'Interactive list message sent successfully.' });
    } catch (error) {
        console.error('Error sending interactive list message:', error);
        res.status(500).json({ success: false, error: 'Failed to send interactive list message.' });
    }
});

// --- NEW API Endpoint for Simple Payment Request Message ---
app.post('/send-payment-request', async (req, res) => {
    const { jid, amount, currency, from, note, quotedMessage } = req.body;
    if (!jid || !amount || !currency || !from) {
        return res.status(400).json({ success: false, error: 'Missing required parameters: jid, amount, currency, or from.' });
    }
    if (!isWhatsappConnected) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });
    }

    try {
        const paymentData = {
            currency: currency,
            amount: parseInt(amount),
            from: from,
            note: note,
            background: {
                backgroundColor: '#ffffff'
            }
        };

        const quoted = quotedMessage ? {
            key: {
                remoteJid: jid,
                id: 'placeholder-id', // Placeholder for a real message ID
            },
            message: { conversation: quotedMessage }
        } : null;

        await sock.sendMessage(jid, { requestPayment: paymentData }, { quoted: quoted });
        res.status(200).json({ success: true, message: 'Payment request message sent successfully.' });
    } catch (error) {
        console.error('Error sending payment request message:', error);
        res.status(500).json({ success: false, error: `Failed to send payment request: ${error.message}` });
    }
});


// --- API Endpoint to Get All Groups ---
app.get('/get-groups', async (req, res) => {
    if (!isWhatsappConnected) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.status(200).json({ success: true, message: 'Groups fetched successfully.', data: groupList });
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch groups.' });
    }
});

// --- API Endpoint to get a single group's info ---
app.get('/get-group/:jid', async (req, res) => {
    const { jid } = req.params;
    if (!isWhatsappConnected) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });

    try {
        const groupMetadata = await sock.groupMetadata(jid);
        res.status(200).json({
            success: true,
            message: 'Group info fetched successfully.',
            data: {
                id: groupMetadata.id,
                name: groupMetadata.subject,
                description: groupMetadata.desc,
                participants: groupMetadata.participants.map(p => ({
                    id: p.id,
                    admin: p.admin,
                }))
            }
        });
    } catch (error) {
        console.error(`Error fetching group ${jid}:`, error);
        res.status(500).json({ success: false, error: `Failed to fetch group info: ${error.message}` });
    }
});

// --- API Endpoint to add user(s) to a group with delay ---
app.post('/add-to-group', async (req, res) => {
    const { groupJid, userNumbers, delayMs } = req.body;
    if (!groupJid || !userNumbers || !Array.isArray(userNumbers) || userNumbers.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
    if (!isWhatsappConnected) return res.status(503).json({ success: false, error: 'WhatsApp client is not ready.' });

    try {
        const userJids = userNumbers.map(num => `${num.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
        let addedCount = 0;
        let failedCount = 0;
        const failedUsers = [];

        for (const jid of userJids) {
            try {
                await sock.groupParticipantsUpdate(groupJid, [jid], 'add');
                addedCount++;
            } catch (error) {
                failedCount++;
                failedUsers.push(jid);
                console.error(`Failed to add user ${jid}:`, error.message);
            }
            if (delayMs && userJids.indexOf(jid) < userJids.length - 1) {
                await delay(delayMs);
            }
        }

        res.status(200).json({
            success: true,
            message: `Batch add completed. Added ${addedCount}. Failed ${failedCount}.`,
            failedUsers: failedUsers,
        });
    } catch (error) {
        console.error('Error in batch add operation:', error);
        res.status(500).json({ success: false, error: `Failed to add users to group: ${error.message}` });
    }
});

// --- Start the server ---
connectToWhatsApp().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
        console.log('API Endpoints available:');
        console.log('  POST /send-text-message');
        console.log('  POST /send-interactive-message');
        console.log('  POST /send-product-message');
        console.log('  POST /send-interactive-list-message');
        console.log('  POST /send-payment-request');
        console.log('  GET /get-groups');
        console.log('  GET /get-group/:jid');
        console.log('  POST /add-to-group');
    });
}).catch(err => {
    console.log("Failed to connect to WhatsApp:", err);
});