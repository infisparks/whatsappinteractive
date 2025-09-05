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
        printQRInTerminal: false,
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

// --- API Endpoint to Send a Simple Text Message ---
app.post('/send-text-message', async (req, res) => {
    const { jid, text } = req.body;

    if (!jid || !text) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, text'
        });
    }

    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending text message to: ${jid}`);
        await sock.sendMessage(jid, { text: text });
        res.status(200).json({ success: true, message: 'Text message sent successfully.' });
    } catch (error) {
        console.error('Error sending text message:', error);
        res.status(500).json({ success: false, error: 'Failed to send text message.' });
    }
});


// --- API Endpoint to Send a Simple Button Message (Reply Buttons Only) ---
app.post('/send-button-message', async (req, res) => {
    const { jid, text, footer, button1, button2, button3 } = req.body;

    if (!jid || !text || !button1) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, text, button1'
        });
    }
    
    if (!isWhatsappConnected) {
         return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending button message to: ${jid}`);
        const buttons = [
            { buttonId: 'id1', buttonText: { displayText: button1 }, type: 1 }
        ];
        if (button2) buttons.push({ buttonId: 'id2', buttonText: { displayText: button2 }, type: 1 });
        if (button3) buttons.push({ buttonId: 'id3', buttonText: { displayText: button3 }, type: 1 });

        const buttonMessage = {
            text: text,
            footer: footer || '',
            buttons: buttons,
            headerType: 1
        };

        await sock.sendMessage(jid, buttonMessage);
        res.status(200).json({ success: true, message: 'Button message sent successfully.' });
    } catch (error) {
        console.error('Error sending button message:', error);
        res.status(500).json({ success: false, error: 'Failed to send message.' });
    }
});

// --- API Endpoint to Send an Image with Reply Buttons ---
app.post('/send-image-buttons', async (req, res) => {
    const { jid, imageUrl, caption, footer, button1, button2, button3 } = req.body;

    if (!jid || !imageUrl || !caption || !button1) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, imageUrl, caption, button1'
        });
    }

    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending image with buttons to: ${jid}`);
        const buttons = [
            { buttonId: 'id1', buttonText: { displayText: button1 }, type: 1 }
        ];
        if (button2) buttons.push({ buttonId: 'id2', buttonText: { displayText: button2 }, type: 1 });
        if (button3) buttons.push({ buttonId: 'id3', buttonText: { displayText: button3 }, type: 1 });

        const buttonMessage = {
            image: { url: imageUrl },
            caption: caption,
            footer: footer || '',
            buttons: buttons,
            headerType: 4
        };

        await sock.sendMessage(jid, buttonMessage);
        res.status(200).json({ success: true, message: 'Image with buttons sent successfully.' });
    } catch (error) {
        console.error('Error sending image with buttons:', error);
        res.status(500).json({ success: false, error: 'Failed to send message.' });
    }
});


// --- API Endpoint to Send an INTERACTIVE Message with URL, Reply Buttons, and Optional Media ---
app.post('/send-interactive-message', async (req, res) => {
    const { jid, body, footer, buttons, imageUrl, title, subtitle } = req.body;

    if (!jid || !body || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, body, and a non-empty buttons array'
        });
    }
    
    if (!isWhatsappConnected) {
         return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending interactive message to: ${jid}`);
        const interactiveButtons = buttons.map(btn => {
            if (btn.type === 'url' && btn.displayText && btn.url) {
                return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        url: btn.url
                    })
                };
            } else if (btn.type === 'reply' && btn.displayText && btn.id) {
                 return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        id: btn.id
                    })
                };
            }
            return null;
        }).filter(Boolean);

        if (interactiveButtons.length === 0) {
             return res.status(400).json({
                success: false,
                error: 'No valid buttons were provided. Each button needs a type ("url" or "reply") and required fields.'
            });
        }
        
        let interactiveMessage;
        if (imageUrl) {
            interactiveMessage = {
                image: { url: imageUrl },
                caption: body,
                title: title || '',
                subtitle: subtitle || '',
                footer: footer || '',
                media: true,
                interactiveButtons: interactiveButtons
            };
        } else {
            interactiveMessage = {
                text: body,
                footer: footer || '',
                interactiveButtons: interactiveButtons
            };
        }

        await sock.sendMessage(jid, interactiveMessage);
        res.status(200).json({ success: true, message: 'Interactive message sent successfully.' });
    } catch (error) {
        console.error('Error sending interactive message:', error);
        res.status(500).json({ success: false, error: 'Failed to send interactive message.' });
    }
});

// --- API Endpoint to Send a Native Flow Message with All Button Types ---
app.post('/send-native-flow', async (req, res) => {
    const { jid, body, footer, title, subtitle } = req.body;

    if (!jid || !body || !footer || !title) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, body, footer, title'
        });
    }

    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending Native Flow message to: ${jid}`);
        const interactiveMessage = {
            body: { text: body },
            footer: { text: footer },
            header: {
                title: title,
                subtitle: subtitle || ' ',
                hasMediaAttachment: false
            },
            nativeFlowMessage: {
                buttons: [
                    {
                        name: "single_select",
                        buttonParamsJson: JSON.stringify({
                            title: "Select an option",
                            sections: [{
                                title: "Available Choices",
                                highlight_label: "POPULAR",
                                rows: [
                                    { header: "Option A", title: "First Choice", description: "This is the first item", id: "choice_1" },
                                    { header: "Option B", title: "Second Choice", description: "This is the second item", id: "choice_2" }
                                ]
                            }]
                        })
                    },
                    {
                        name: "cta_reply",
                        buttonParamsJson: JSON.stringify({ display_text: "Quick Reply", id: "reply-btn-id" })
                    },
                    {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({ display_text: "Visit Google", url: "https://www.google.com" })
                    },
                    {
                        name: "cta_call",
                        buttonParamsJson: JSON.stringify({ display_text: "Call Us", id: "call-btn-id" })
                    },
                    {
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({ display_text: "Copy Code", id: "copy-btn-id", copy_code: "YOUR_CODE_123" })
                    },
                    { name: "cta_reminder", buttonParamsJson: JSON.stringify({ display_text: "Set Reminder", id: "reminder-btn" }) },
                    { name: "cta_cancel_reminder", buttonParamsJson: JSON.stringify({ display_text: "Cancel Reminder", id: "cancel-reminder-btn" }) },
                    { name: "address_message", buttonParamsJson: JSON.stringify({ display_text: "Send Address", id: "address-btn" }) },
                    { name: "send_location", buttonParamsJson: "" }
                ],
            }
        };

        const prepMsg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.create(interactiveMessage)
                }
            }
        }, {});

        await sock.relayMessage(jid, prepMsg.message, { messageId: prepMsg.key.id });
        res.status(200).json({ success: true, message: 'Native Flow message sent successfully.' });
    } catch (error) {
        console.error('Error sending Native Flow message:', error);
        res.status(500).json({ success: false, error: 'Failed to send Native Flow message.' });
    }
});

// --- API Endpoint to Send an Interactive Product Message ---
app.post('/send-product-message', async (req, res) => {
    const {
        jid, businessOwnerJid, productImageUrl, productTitle, productDescription,
        price, currencyCode, retailerId, productUrl,
        caption, footer, buttons
    } = req.body;

    if (!jid || !businessOwnerJid || !productTitle || !price || !currencyCode || !caption || !buttons) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters. Please provide jid, businessOwnerJid, productTitle, price, currencyCode, caption, and buttons.'
        });
    }

    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending Product message to: ${jid}`);
        const interactiveButtons = buttons.map(btn => {
            if (btn.type === 'url' && btn.displayText && btn.url) {
                return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
            } else if (btn.type === 'reply' && btn.displayText && btn.id) {
                return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
            }
            return null;
        }).filter(Boolean);

        if (interactiveButtons.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid buttons were provided.' });
        }

        const productMessage = {
            product: {
                productImage: { url: productImageUrl },
                productImageCount: 1,
                title: productTitle,
                description: productDescription || '',
                priceAmount1000: price * 1000,
                currencyCode: currencyCode.toUpperCase(),
                retailerId: retailerId || '',
                url: productUrl || ''
            },
            businessOwnerJid: businessOwnerJid,
            caption: caption,
            footer: footer || '',
            media: true,
            interactiveButtons: interactiveButtons
        };

        await sock.sendMessage(jid, productMessage);
        res.status(200).json({ success: true, message: 'Product message sent successfully.' });
    } catch (error) {
        console.error('Error sending product message:', error);
        res.status(500).json({ success: false, error: 'Failed to send product message.' });
    }
});


// --- NEW: API Endpoint to Send an Album Message ---
app.post('/send-album-message', async (req, res) => {
    const { jid, mediaItems, delay } = req.body;

    if (!jid || !mediaItems || !Array.isArray(mediaItems) || mediaItems.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid and a non-empty mediaItems array.'
        });
    }

    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    // Convert mediaItems to the correct format
    const albumItems = mediaItems.map(item => {
        const media = {};
        if (item.type === 'image') {
            media.image = { url: item.url };
        } else if (item.type === 'video') {
            media.video = { url: item.url };
        }
        if (item.caption) {
            media.caption = item.caption;
        }
        return media;
    });

    try {
        console.log(`Sending album message to: ${jid}`);
        // The Baileys-pro library might have a different method signature for sendAlbumMessage
        // Let's assume the method signature is as described in the user's prompt.
        await sock.sendAlbumMessage(
            jid,
            albumItems,
            { delay: delay || 0 } // Use user-provided delay or default to 0
        );
        res.status(200).json({ success: true, message: 'Album message sent successfully.' });
    } catch (error) {
        console.error('Error sending album message:', error);
        res.status(500).json({ success: false, error: 'Failed to send album message. Check if the Baileys-pro library supports this method and if the media URLs are valid.' });
    }
});


// --- API Endpoint to Get All Groups ---
app.get('/get-groups', async (req, res) => {
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log('Fetching all groups...');
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            id: group.id,
            name: group.subject
        }));

        res.status(200).json({
            success: true,
            message: 'Groups fetched successfully.',
            data: groupList
        });

    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch groups.' });
    }
});


// --- Start the server ---
connectToWhatsApp().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
        console.log('API Endpoints available:');
        console.log('  POST /send-text-message');
        console.log('  POST /send-button-message');
        console.log('  POST /send-image-buttons');
        console.log('  POST /send-interactive-message');
        console.log('  POST /send-native-flow');
        console.log('  POST /send-product-message');
        console.log('  POST /send-album-message'); // NEW endpoint
        console.log('  GET /get-groups');
    });
}).catch(err => {
    console.log("Failed to connect to WhatsApp:", err);
});