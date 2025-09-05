const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    generateWAMessageFromContent, // <-- Import for advanced message creation
    proto // <-- Import for message structure
} = require('@fizzxydev/baileys-pro');
const { Boom } = require('@hapi/boom');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const axios = require('axios'); // Import axios for downloading media

// Initialize Express app
const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// We need to keep the Baileys socket instance and connection status available globally
let sock;
let isWhatsappConnected = false;

// Main function to connect to WhatsApp
async function connectToWhatsApp() {
    // useMultiFileAuthState will store and read session credentials from a folder
    const { state, saveCreds } = await useMultiFileAuthState(path.resolve(__dirname, 'auth_info_baileys'));

    // Create a new socket connection
    sock = makeWASocket({
        // Do not print QR in terminal automatically, we will handle it manually
        printQRInTerminal: false, 
        auth: state,
    });

    // Listen for connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("QR Code received, please scan:");
            // Generate QR code in terminal using the qrcode-terminal library
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isWhatsappConnected = false; // Update connection status
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isWhatsappConnected = true; // Update connection status
            console.log('Opened connection');
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);

    // You can add other event listeners here if needed, like 'messages.upsert'
    sock.ev.on('messages.upsert', (event) => {
        console.log('Received messages:', JSON.stringify(event.messages, null, 2));
    });

    return sock;
}

// --- API Endpoint to Send a Simple Text Message ---
app.post('/send-text-message', async (req, res) => {
    const { jid, text } = req.body;

    // Basic validation
    if (!jid || !text) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, text'
        });
    }

    // Check connection status
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending text message to: ${jid}`);
        
        // Send the simple text message
        await sock.sendMessage(jid, { text: text });

        res.status(200).json({ success: true, message: 'Text message sent successfully.' });

    } catch (error) {
        console.error('Error sending text message:', error);
        res.status(500).json({ success: false, error: 'Failed to send text message.' });
    }
});


// --- API Endpoint to Send a Simple Button Message (Reply Buttons Only) ---
app.post('/send-button-message', async (req, res) => {
    // Extract recipient JID and message content from the request body
    const { jid, text, footer, button1, button2, button3 } = req.body;

    // Basic validation
    if (!jid || !text || !button1) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required parameters: jid, text, button1' 
        });
    }
    
    // Check our custom connection status flag
    if (!isWhatsappConnected) {
         return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.' 
        });
    }

    try {
        console.log(`Sending button message to: ${jid}`);
        
        // Construct the buttons array dynamically
        const buttons = [
            { buttonId: 'id1', buttonText: { displayText: button1 }, type: 1 }
        ];
        if (button2) buttons.push({ buttonId: 'id2', buttonText: { displayText: button2 }, type: 1 });
        if (button3) buttons.push({ buttonId: 'id3', buttonText: { displayText: button3 }, type: 1 });

        // Define the button message content
        const buttonMessage = {
            text: text,
            footer: footer || '', // Optional footer
            buttons: buttons,
            headerType: 1
        };

        // Send the message
        await sock.sendMessage(jid, buttonMessage);

        // Send a success response
        res.status(200).json({ success: true, message: 'Button message sent successfully.' });

    } catch (error) {
        console.error('Error sending button message:', error);
        res.status(500).json({ success: false, error: 'Failed to send message.' });
    }
});

// --- API Endpoint to Send an Image with Reply Buttons ---
app.post('/send-image-buttons', async (req, res) => {
    const { jid, imageUrl, caption, footer, button1, button2, button3 } = req.body;

    // Basic validation
    if (!jid || !imageUrl || !caption || !button1) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, imageUrl, caption, button1'
        });
    }

    // Check our custom connection status flag
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending image with buttons to: ${jid}`);

        // Construct the buttons array
        const buttons = [
            { buttonId: 'id1', buttonText: { displayText: button1 }, type: 1 }
        ];
        if (button2) buttons.push({ buttonId: 'id2', buttonText: { displayText: button2 }, type: 1 });
        if (button3) buttons.push({ buttonId: 'id3', buttonText: { displayText: button3 }, type: 1 });

        // Define the button message with an image header
        const buttonMessage = {
            image: { url: imageUrl },
            caption: caption,
            footer: footer || '',
            buttons: buttons,
            headerType: 4 // Type 4 indicates an image header
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
    // Extract JID and message parts from the request body
    const { jid, body, footer, buttons, imageUrl, title, subtitle } = req.body;

    // Basic validation
    if (!jid || !body || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required parameters: jid, body, and a non-empty buttons array' 
        });
    }
    
    // Check our custom connection status flag
    if (!isWhatsappConnected) {
         return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.' 
        });
    }

    try {
        console.log(`Sending interactive message to: ${jid}`);
        
        // Map the simplified button format from the request to the Baileys format
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
            return null; // Return null for invalid button structures
        }).filter(Boolean); // Filter out any nulls from invalid button objects

        if (interactiveButtons.length === 0) {
             return res.status(400).json({ 
                success: false, 
                error: 'No valid buttons were provided. Each button needs a type ("url" or "reply") and required fields.' 
            });
        }
        
        // Define the interactive message content, conditionally adding media
        let interactiveMessage;

        if (imageUrl) {
            // If an image URL is provided, send it as a media interactive message
            interactiveMessage = {
                image: { url: imageUrl },
                caption: body, // Use the body as the caption
                title: title || '',
                subtitle: subtitle || '',
                footer: footer || '',
                media: true, // This flag indicates it's a media message
                interactiveButtons: interactiveButtons
            };
        } else {
            // Otherwise, send a standard text interactive message
            interactiveMessage = {
                text: body,
                footer: footer || '',
                interactiveButtons: interactiveButtons
            };
        }

        // Send the message
        await sock.sendMessage(jid, interactiveMessage);

        // Send a success response
        res.status(200).json({ success: true, message: 'Interactive message sent successfully.' });

    } catch (error) {
        console.error('Error sending interactive message:', error);
        res.status(500).json({ success: false, error: 'Failed to send interactive message.' });
    }
});

// --- API Endpoint to Send a Native Flow Message with All Button Types ---
app.post('/send-native-flow', async (req, res) => {
    const { jid, body, footer, title, subtitle } = req.body;

    // Basic validation
    if (!jid || !body || !footer || !title) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: jid, body, footer, title'
        });
    }

    // Check connection status
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending Native Flow message to: ${jid}`);

        // This is a complex message structure that includes many types of buttons.
        // It's constructed using the low-level 'proto' interface from Baileys.
        const interactiveMessage = {
            body: { text: body },
            footer: { text: footer },
            header: {
                title: title,
                subtitle: subtitle || ' ', // Subtitle is optional but field should exist
                hasMediaAttachment: false
            },
            nativeFlowMessage: {
                buttons: [
                    // --- This button opens a selectable list ---
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
                    // --- Standard Quick Reply Button ---
                    {
                        name: "cta_reply",
                        buttonParamsJson: JSON.stringify({ display_text: "Quick Reply", id: "reply-btn-id" })
                    },
                    // --- URL Button ---
                    {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({ display_text: "Visit Google", url: "https://www.google.com" })
                    },
                    // --- Call Button ---
                    {
                        name: "cta_call",
                        buttonParamsJson: JSON.stringify({ display_text: "Call Us", id: "call-btn-id" })
                    },
                    // --- Copy to Clipboard Button ---
                    {
                        name: "cta_copy",
                        buttonParamsJson: JSON.stringify({ display_text: "Copy Code", id: "copy-btn-id", copy_code: "YOUR_CODE_123" })
                    },
                    // --- Other button types (less common but supported) ---
                    { name: "cta_reminder", buttonParamsJson: JSON.stringify({ display_text: "Set Reminder", id: "reminder-btn" }) },
                    { name: "cta_cancel_reminder", buttonParamsJson: JSON.stringify({ display_text: "Cancel Reminder", id: "cancel-reminder-btn" }) },
                    { name: "address_message", buttonParamsJson: JSON.stringify({ display_text: "Send Address", id: "address-btn" }) },
                    { name: "send_location", buttonParamsJson: "" }
                ],
            }
        };

        // We prepare the message using generateWAMessageFromContent
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

        // And send it using relayMessage
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

    // Basic validation
    if (!jid || !businessOwnerJid || !productTitle || !price || !currencyCode || !caption || !buttons) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters. Please provide jid, businessOwnerJid, productTitle, price, currencyCode, caption, and buttons.'
        });
    }

    // Check connection status
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log(`Sending Product message to: ${jid}`);

        // Map the simplified button format from the request to the Baileys format
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

        // Construct the product message payload
        const productMessage = {
            product: {
                productImage: { url: productImageUrl },
                productImageCount: 1,
                title: productTitle,
                description: productDescription || '',
                priceAmount1000: price * 1000, // Price must be multiplied by 1000
                currencyCode: currencyCode.toUpperCase(),
                retailerId: retailerId || '',
                url: productUrl || ''
            },
            businessOwnerJid: businessOwnerJid,
            caption: caption,
            footer: footer || '',
            media: true, // This is essential for product messages
            interactiveButtons: interactiveButtons
        };

        // Send the message
        await sock.sendMessage(jid, productMessage);

        res.status(200).json({ success: true, message: 'Product message sent successfully.' });

    } catch (error) {
        console.error('Error sending product message:', error);
        res.status(500).json({ success: false, error: 'Failed to send product message.' });
    }
});

// --- API Endpoint to Get All Groups ---
app.get('/get-groups', async (req, res) => {
    // Check connection status
    if (!isWhatsappConnected) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please wait for the "Opened connection" message.'
        });
    }

    try {
        console.log('Fetching all groups...');
        
        // Fetch all groups the bot is a part of
        const groups = await sock.groupFetchAllParticipating();
        
        // Format the data to be more user-friendly
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
// First, connect to WhatsApp, then start the Express server
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
        console.log('  GET /get-groups');
    });
}).catch(err => {
    console.log("Failed to connect to WhatsApp:", err);
});

