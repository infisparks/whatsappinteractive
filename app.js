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
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const P = require('pino');

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const sessionStates = new Map();
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

const pendingTasks = new Map();

const logFilePath = path.join(__dirname, 'logs', 'baileys.log');
const logDir = path.dirname(logFilePath);

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
const logger = P({ level: 'debug' }, P.destination(logFilePath));

function readTemplates() {
    try {
        if (fs.existsSync(TEMPLATES_FILE)) {
            const data = fs.readFileSync(TEMPLATES_FILE, 'utf8');
            return JSON.parse(data);
        }
        return {};
    } catch (error) {
        console.error('Error reading templates.json:', error);
        return {};
    }
}

function writeTemplates(templates) {
    try {
        fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
        console.log('Templates saved successfully.');
    } catch (error) {
        console.error('Error writing templates.json:', error);
    }
}

async function connectToWhatsApp(sessionName) {
    if (sessions.has(sessionName)) {
        console.log(`Session ${sessionName} already exists.`);
        return;
    }

    const sessionPath = path.resolve(__dirname, 'auth_info_baileys', sessionName);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    sessionStates.set(sessionName, {
        connection: 'connecting',
        lastDisconnect: null,
        qr: null
    });
    
    const sock = makeWASocket({
        logger: logger,
        printQRInTerminal: false,
        auth: state,
    });

    sessions.set(sessionName, sock);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        sessionStates.get(sessionName).connection = connection;
        
        if (qr) {
            sessionStates.get(sessionName).qr = qr;
            console.log(`QR Code received for session ${sessionName}.`);
        }

        if (connection === 'close') {
            sessionStates.get(sessionName).lastDisconnect = lastDisconnect;
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection for session ${sessionName} closed due to `, lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                sessions.delete(sessionName);
                connectToWhatsApp(sessionName);
            } else {
                console.log(`Session ${sessionName} logged out. Deleting auth info.`);
                sessions.delete(sessionName);
            }
        } else if (connection === 'open') {
            console.log(`Connection for session ${sessionName} opened.`);
            sessionStates.get(sessionName).qr = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (event) => {
        const message = event.messages[0];
        if (!message || !message.message) return;

        const jid = message.key.remoteJid;
        const textMessage = message.message?.conversation || message.message?.extendedTextMessage?.text || '';

        if (textMessage.toLowerCase().trim() === 'hello') {
            await sock.sendMessage(jid, { text: 'Hello World!' });
        }
        
        if (textMessage.toLowerCase().trim() === 'demo') {
            console.log('Received "demo" message. Sending product message.');
            const demoProductMessage = {
                jid: jid,
                businessOwnerJid: "919958399157@s.whatsapp.net",
                product: {
                    imageUrl: "https://raw.githubusercontent.com/infisparks/images/refs/heads/main/Purple%20and%20White%20Simple%20World%20NGO%20Day%20Social%20Media%20Graphic%20(1000%20x%20400%20px).png",
                    title: "Infispark: The Future of Interactive Messaging ✨",
                    description: "Unlock powerful communication tools with our interactive WhatsApp API. From automated replies to rich media and product catalogs, we empower your business to connect and convert like never before! 🚀",
                    price: 999,
                    currencyCode: "INR",
                    retailerId: "INFISPARK_PROD_1"
                },
                message: {
                    caption: "Revolutionize your *business communication* now!",
                    title: "🎉 Exclusive Offer for Our Valued Clients!",
                    footer: "Creative Message"
                },
                buttons: [
                    {
                        type: "url",
                        displayText: "🔗 Explore Our Website",
                        url: "https://www.infispark.com"
                    },
                    {
                        type: "reply",
                        displayText: "🙋 Get a Free Demo",
                        id: "DEMO_INQUIRY"
                    },
                    {
                        type: "reply",
                        displayText: "💰 View Pricing",
                        id: "PRICING_INQUIRY"
                    }
                ]
            };
            
            try {
                await sendProductMessage(sock, jid, demoProductMessage);
                console.log('Successfully sent product message in response to "demo".');
            } catch (error) {
                console.error('Failed to send product message in response to "demo":', error);
            }
        }
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendProductMessage(sock, jid, data) {
    const { businessOwnerJid, product, message, buttons } = data;

    const interactiveButtons = buttons.map(btn => {
        if (btn.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
        if (btn.type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
        return null;
    }).filter(Boolean);

    if (interactiveButtons.length === 0) {
        throw new Error('No valid buttons provided.');
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
}

async function processBulkTask(sessionName) {
    const task = pendingTasks.get(sessionName);
    if (!task) return;

    const sock = sessions.get(sessionName);
    if (!sock || sessionStates.get(sessionName)?.connection !== 'open' || task.status !== 'running') {
        task.status = 'paused';
        return;
    }

    while (task.currentIndex < task.targets.length && task.status === 'running') {
        const target = task.targets[task.currentIndex];
        try {
            if (task.type === 'message') {
                await sendTemplate(sock, task.template, target);
            } else if (task.type === 'group_add') {
                const userJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                await sock.groupParticipantsUpdate(task.groupJid, [userJid], 'add');
            }
            task.sentCount++;
        } catch (error) {
            console.error(`Failed to process task for ${target}:`, error);
            task.failedCount++;
            task.failedTargets.push(target);
        }
        task.currentIndex++;
        await delay(task.delay);
    }
    
    if (task.currentIndex >= task.targets.length) {
        task.status = 'completed';
        task.endTime = new Date();
        console.log(`Bulk task for session ${sessionName} completed.`);
    }
}

async function sendTemplate(sock, template, jid) {
    const messageContent = {};

    switch (template.type) {
        case 'text':
            messageContent.text = template.data.text;
            break;
        case 'interactive':
            const interactiveButtons = template.data.buttons.map(btn => {
                if (btn.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
                if (btn.type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
                return null;
            }).filter(Boolean);
            messageContent.caption = template.data.body;
            if (template.data.imageUrl) {
                 messageContent.image = { url: template.data.imageUrl };
            }
            messageContent.footer = template.data.footer;
            messageContent.interactiveButtons = interactiveButtons;
            break;
        case 'product':
            await sendProductMessage(sock, jid, template.data);
            return;
        case 'poll':
            messageContent.poll = {
                name: template.data.question,
                values: template.data.options,
                selectableOptionsCount: template.data.selectableOptionsCount || 1
            };
            break;
        case 'nativeflow':
            const nativeFlowMessage = proto.Message.InteractiveMessage.create({
                header: proto.Message.InteractiveMessage.Header.create({
                    title: template.data.title,
                    subtitle: template.data.subtitle,
                    hasMediaAttachment: false
                }),
                body: proto.Message.InteractiveMessage.Body.create({ text: template.data.body }),
                footer: proto.Message.InteractiveMessage.Footer.create({ text: template.data.footer }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                    buttons: template.data.buttons.map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params) }))
                })
            });
            const msg = generateWAMessageFromContent(jid, {
                viewOnceMessage: { message: { interactiveMessage: nativeFlowMessage } }
            }, {});
            await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
            return;
        default:
            throw new Error(`Unsupported template type: ${template.type}`);
    }
    
    await sock.sendMessage(jid, messageContent);
}

app.post('/create-session', (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) return res.status(400).json({ success: false, error: 'Session name is required.' });
    if (sessions.has(sessionName)) return res.status(409).json({ success: false, error: `Session '${sessionName}' already exists.` });
    connectToWhatsApp(sessionName).catch(err => {
        console.error(`Error creating session ${sessionName}:`, err);
        res.status(500).json({ success: false, error: 'Failed to create session.' });
    });
    res.status(200).json({ success: true, message: `Session creation for '${sessionName}' initiated.` });
});

app.get('/get-qr/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const sessionState = sessionStates.get(sessionName);
    if (!sessionState) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionState.qr) {
        try {
            const qrImage = await qrcode.toDataURL(sessionState.qr);
            return res.status(200).json({ success: true, qrImage: qrImage, connection: sessionState.connection });
        } catch (error) {
            console.error('Error generating QR code:', error);
            return res.status(500).json({ success: false, error: 'Failed to generate QR code image.' });
        }
    } else {
        return res.status(200).json({ success: true, qrImage: null, connection: sessionState.connection });
    }
});

app.get('/get-sessions', (req, res) => {
    const sessionsList = Array.from(sessions.keys()).map(name => ({
        name: name,
        connection: sessionStates.get(name)?.connection || 'unknown'
    }));
    res.status(200).json({ success: true, data: sessionsList });
});

// Corrected route definitions
app.get('/templates', (req, res) => {
    const allTemplates = readTemplates();
    res.status(200).json({ success: true, data: allTemplates });
});

app.get('/templates/:type', (req, res) => {
    const { type } = req.params;
    const allTemplates = readTemplates();
    const filteredTemplates = {};
    for (const name in allTemplates) {
        if (allTemplates[name].type === type) {
            filteredTemplates[name] = allTemplates[name].data;
        }
    }
    res.status(200).json({ success: true, data: filteredTemplates });
});

app.post('/templates', (req, res) => {
    const { name, type, data } = req.body;
    if (!name || !type || !data) return res.status(400).json({ success: false, error: 'Template name, type, and data are required.' });
    const templates = readTemplates();
    templates[name] = { type, data };
    writeTemplates(templates);
    res.status(200).json({ success: true, message: `Template '${name}' saved successfully.` });
});

app.post('/send-bulk-template', async (req, res) => {
    const { sessionName, templateName, numbers, delay } = req.body;
    if (!sessionName || !templateName || !numbers || !Array.isArray(numbers) || numbers.length === 0 || delay === undefined) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
    if (pendingTasks.has(sessionName) && pendingTasks.get(sessionName).status === 'running') {
        return res.status(409).json({ success: false, error: 'A bulk task is already running for this session.' });
    }

    const templates = readTemplates();
    const template = templates[templateName];
    if (!template) {
        return res.status(404).json({ success: false, error: 'Template not found.' });
    }

    const jids = numbers.map(num => `${num.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
    const task = {
        type: 'message',
        template: template,
        targets: jids,
        total: jids.length,
        sentCount: 0,
        failedCount: 0,
        failedTargets: [],
        currentIndex: 0,
        status: 'running',
        delay: delay,
        startTime: new Date()
    };
    pendingTasks.set(sessionName, task);

    res.status(200).json({ success: true, message: 'Bulk message task started successfully.', task });

    processBulkTask(sessionName);
});

app.post('/add-to-group-bulk', async (req, res) => {
    const { sessionName, groupJid, userNumbers, delay } = req.body;
    if (!sessionName || !groupJid || !userNumbers || !Array.isArray(userNumbers) || userNumbers.length === 0 || delay === undefined) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
    if (pendingTasks.has(sessionName) && pendingTasks.get(sessionName).status === 'running') {
        return res.status(409).json({ success: false, error: 'A bulk task is already running for this session.' });
    }

    const task = {
        type: 'group_add',
        groupJid: groupJid,
        targets: userNumbers,
        total: userNumbers.length,
        sentCount: 0,
        failedCount: 0,
        failedTargets: [],
        currentIndex: 0,
        status: 'running',
        delay: delay,
        startTime: new Date()
    };
    pendingTasks.set(sessionName, task);

    res.status(200).json({ success: true, message: 'Bulk add to group task started successfully.', task });

    processBulkTask(sessionName);
});

app.post('/cancel-bulk-task', (req, res) => {
    const { sessionName } = req.body;
    const task = pendingTasks.get(sessionName);
    if (!task) {
        return res.status(404).json({ success: false, error: 'No active bulk task for this session.' });
    }
    task.status = 'cancelled';
    task.endTime = new Date();
    res.status(200).json({ success: true, message: 'Bulk task has been cancelled.' });
});

app.get('/get-bulk-status/:sessionName', (req, res) => {
    const { sessionName } = req.params;
    const task = pendingTasks.get(sessionName);
    if (!task) {
        return res.status(404).json({ success: false, error: 'No active bulk task for this session.' });
    }
    res.status(200).json({ success: true, data: task });
});

app.post('/send-text-message', async (req, res) => {
    const { sessionName, jid, text } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!jid || !text) return res.status(400).json({ success: false, error: 'Missing jid or text' });
    try {
        await sock.sendMessage(jid, { text: text });
        res.status(200).json({ success: true, message: 'Text message sent successfully.' });
    } catch (error) {
        console.error('Error sending text message:', error);
        res.status(500).json({ success: false, error: 'Failed to send text message.' });
    }
});

app.post('/send-interactive-message', async (req, res) => {
    const { sessionName, jid, body, footer, buttons, imageUrl, title, subtitle } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!jid || !body || !buttons) return res.status(400).json({ success: false, error: 'Missing required parameters' });
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

app.post('/send-product-message', async (req, res) => {
    const { sessionName, jid, businessOwnerJid, product, message, buttons } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!jid || !businessOwnerJid || !product || !message || !buttons) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
    try {
        await sendProductMessage(sock, jid, req.body);
        res.status(200).json({ success: true, message: 'Product message sent successfully.' });
    } catch (error) {
        console.error('Error sending product message:', error);
        res.status(500).json({ success: false, error: `Failed to send product message: ${error.message}` });
    }
});

app.post('/send-native-flow-message', async (req, res) => {
    const { sessionName, jid, title, subtitle, body, footer, buttons } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!jid || !body || !buttons) {
        return res.status(400).json({ success: false, error: 'Missing required parameters: jid, body, or buttons.' });
    }
    try {
        const interactiveMessage = proto.Message.InteractiveMessage.create({
            header: proto.Message.InteractiveMessage.Header.create({
                title: title,
                subtitle: subtitle,
                hasMediaAttachment: false
            }),
            body: proto.Message.InteractiveMessage.Body.create({
                text: body
            }),
            footer: proto.Message.InteractiveMessage.Footer.create({
                text: footer
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: buttons.map(btn => {
                    return {
                        name: btn.name,
                        buttonParamsJson: JSON.stringify(btn.params)
                    };
                }),
            })
        });

        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: interactiveMessage
                }
            }
        }, {});
        
        await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });

        res.status(200).json({ success: true, message: 'NativeFlow message sent successfully.' });
    } catch (error) {
        console.error('Error sending NativeFlow message:', error);
        res.status(500).json({ success: false, error: `Failed to send NativeFlow message: ${error.message}` });
    }
});

app.post('/send-poll-message', async (req, res) => {
    const { sessionName, jid, question, options, selectableOptionsCount } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!jid || !question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ success: false, error: 'Missing required parameters: jid, question, or at least two options.' });
    }
    try {
        const pollMessage = {
            poll: {
                name: question,
                values: options,
                selectableOptionsCount: selectableOptionsCount || 1
            }
        };

        await sock.sendMessage(jid, pollMessage);
        res.status(200).json({ success: true, message: 'Poll message sent successfully.' });
    } catch (error) {
        console.error('Error sending poll message:', error);
        res.status(500).json({ success: false, error: `Failed to send poll message: ${error.message}` });
    }
});

app.get('/get-groups/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.status(200).json({ success: true, message: 'Groups fetched successfully.', data: groupList });
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch groups.' });
    }
});

app.get('/get-group/:sessionName/:jid', async (req, res) => {
    const { sessionName, jid } = req.params;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });

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

app.post('/add-to-group', async (req, res) => {
    const { sessionName, groupJid, userNumbers, delayMs } = req.body;
    const sock = sessions.get(sessionName);
    if (!sock) return res.status(404).json({ success: false, error: 'Session not found.' });
    if (sessionStates.get(sessionName)?.connection !== 'open') return res.status(503).json({ success: false, error: 'WhatsApp client for this session is not ready.' });
    if (!groupJid || !userNumbers || !Array.isArray(userNumbers) || userNumbers.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing required parameters.' });
    }
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

async function startup() {
    const authDir = path.resolve(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authDir)) {
        const sessionFolders = fs.readdirSync(authDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const sessionName of sessionFolders) {
            console.log(`Found existing session: ${sessionName}. Attempting to reconnect...`);
            await connectToWhatsApp(sessionName).catch(err => {
                console.error(`Failed to reconnect to session ${sessionName}:`, err);
            });
        }
    }
}

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log('API Endpoints available:');
    console.log('  POST /create-session');
    console.log('  GET /get-sessions');
    console.log('  GET /get-qr/:sessionName');
    console.log('  GET /templates');
    console.log('  POST /templates');
    console.log('  POST /send-template');
    console.log('  POST /send-bulk-template');
    console.log('  GET /get-bulk-status/:sessionName');
    console.log('  POST /cancel-bulk-task');
    console.log('  POST /add-to-group-bulk');
    console.log('  POST /send-text-message');
    console.log('  POST /send-interactive-message');
    console.log('  POST /send-product-message');
    console.log('  POST /send-native-flow-message');
    console.log('  POST /send-poll-message');
    console.log('  GET /get-groups/:sessionName');
    console.log('  GET /get-group/:sessionName/:jid');
    console.log('  POST /add-to-group');
});

startup();